import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    GetObjectCommand,
    ListObjectsV2Command,
    S3Client,
} from "@aws-sdk/client-s3";
import dotenv from "dotenv";

const envCandidates = [
    path.join(process.cwd(), ".env"),
    path.join(path.dirname(process.execPath), ".env"),
];
let loadedEnvPath: string | undefined;

for (const envPath of [...new Set(envCandidates)]) {
    if (existsSync(envPath)) {
        // Le fichier placé à côté de l'EXE est chargé en dernier et prend priorité
        // sur d'anciennes variables AWS présentes dans le terminal ou Windows.
        dotenv.config({ path: envPath, override: true, quiet: true });
        loadedEnvPath = envPath;
    }
}

const DEFAULT_BUCKET = "test-gcm-lambdas-profiler";
const DEFAULT_REGION = "eu-west-3";
const MAX_PARALLEL_DOWNLOADS = 4;

function printUsage() {
    console.log(`Usage:
  s3_log_downloader.exe <préfixe-s3-complet> [dossier-de-sortie]

Exemple:
  s3_log_downloader.exe "/mod2/d9bd43ca-e943-4832-8421-c63ffdfb9f0c/"

Variables d'environnement optionnelles:
  AWS_REGION   Région AWS (défaut: ${DEFAULT_REGION})
  S3_BUCKET    Bucket S3 (défaut: ${DEFAULT_BUCKET})

Sans dossier de sortie, les fichiers sont enregistrés dans:
  ./s3_logs/<dernier-segment-du-préfixe>/`);
}

function normalizeS3Prefix(value: string): string {
    const prefix = value.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");

    if (!prefix || prefix.split("/").some((segment) => segment === "..")) {
        throw new Error("Le préfixe S3 est invalide.");
    }

    return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function safePathSegment(segment: string): string {
    const sanitized = segment
        .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
        .replace(/[. ]+$/, "");

    if (!sanitized || sanitized === "." || sanitized === "..") {
        throw new Error(`Nom de fichier S3 non pris en charge: ${segment}`);
    }

    return sanitized;
}

function localPathForKey(outputDir: string, prefix: string, key: string): string {
    const relativeKey = key.slice(prefix.length);
    const segments = relativeKey.split("/").filter(Boolean).map(safePathSegment);

    if (segments.length === 0) {
        throw new Error(`Clé S3 invalide: ${key}`);
    }

    return path.join(outputDir, ...segments);
}

async function listJsonKeys(client: S3Client, bucket: string, prefix: string) {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
        const page = await client.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }),
        );

        for (const object of page.Contents ?? []) {
            if (object.Key && object.Key.toLowerCase().endsWith(".json")) {
                keys.push(object.Key);
            }
        }

        continuationToken = page.IsTruncated
            ? page.NextContinuationToken
            : undefined;
    } while (continuationToken);

    return keys;
}

async function downloadObject(
    client: S3Client,
    bucket: string,
    prefix: string,
    key: string,
    outputDir: string,
) {
    const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
    );

    if (!result.Body) {
        throw new Error(`S3 n'a retourné aucun contenu pour ${key}`);
    }

    const destination = localPathForKey(outputDir, prefix, key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await result.Body.transformToByteArray());

    return destination;
}

async function runPool<T>(
    values: T[],
    concurrency: number,
    worker: (value: T) => Promise<void>,
) {
    let nextIndex = 0;

    async function runWorker() {
        while (nextIndex < values.length) {
            const currentIndex = nextIndex++;
            await worker(values[currentIndex]);
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(concurrency, values.length) },
            () => runWorker(),
        ),
    );
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
        printUsage();
        process.exit(args.length === 0 ? 1 : 0);
    }

    const prefix = normalizeS3Prefix(args[0]);
    const region = process.env.AWS_REGION ?? DEFAULT_REGION;
    const bucket = process.env.S3_BUCKET ?? DEFAULT_BUCKET;
    const lastPrefixSegment = prefix.split("/").filter(Boolean).at(-1) ?? "download";
    const outputDir = path.resolve(
        args[1] ?? path.join("s3_logs", safePathSegment(lastPrefixSegment)),
    );
    // Les clés de ce bucket commencent par "/". Avec Bun et le mode virtual-hosted,
    // l'URL contient alors // juste après le domaine et Bun le normalise après la
    // signature, ce qui provoque SignatureDoesNotMatch. Le path-style place le
    // bucket avant ce double slash et conserve le chemin signé.
    const client = new S3Client({ region, forcePathStyle: true });

    console.log(`Fichier .env : ${loadedEnvPath ?? "non trouvé (chaîne AWS standard utilisée)"}`);
    console.log(`Bucket       : s3://${bucket}`);
    console.log(`Préfixe      : ${prefix}`);
    console.log(`Destination  : ${outputDir}`);
    console.log("Recherche des fichiers JSON...");

    const keys = await listJsonKeys(client, bucket, prefix);

    if (keys.length === 0) {
        throw new Error(`Aucun fichier JSON trouvé sous s3://${bucket}${prefix}`);
    }

    console.log(`${keys.length} fichier(s) JSON trouvé(s). Téléchargement...`);
    let downloaded = 0;

    await runPool(keys, MAX_PARALLEL_DOWNLOADS, async (key) => {
        const destination = await downloadObject(
            client,
            bucket,
            prefix,
            key,
            outputDir,
        );
        downloaded += 1;
        console.log(`[${downloaded}/${keys.length}] ${path.relative(outputDir, destination)}`);
    });

    console.log(`\nTerminé : ${downloaded} fichier(s) téléchargé(s) dans ${outputDir}`);
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : "";
    console.error(`\nErreur : ${message}`);

    if (errorName === "ExpiredToken" || /expired/i.test(message)) {
        console.error(
            "Le jeton de session AWS est expiré. Régénère puis remplace ensemble " +
            "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY et AWS_SESSION_TOKEN dans le .env.",
        );
        console.error(`Fichier .env effectivement utilisé : ${loadedEnvPath ?? "aucun"}`);
    } else {
        console.error("Vérifie tes identifiants AWS, la région, le bucket et le préfixe.");
    }

    process.exit(1);
});
