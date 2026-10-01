import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
    GetFunctionConfigurationCommand,
    LambdaClient,
    UpdateFunctionConfigurationCommand,
    waitUntilFunctionUpdated,
} from "@aws-sdk/client-lambda";

export function loadVariables(file: string): Record<string, string> {
    let variables: unknown;
    try {
        variables = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    } catch {
        throw new Error(`Impossible de lire ${file} : fichier absent, inaccessible ou JSON invalide.`);
    }
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
        throw new Error("Le JSON doit contenir un objet de paires clé/valeur.");
    }
    for (const [key, value] of Object.entries(variables)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]+$/.test(key)) {
            throw new Error(`Nom de variable invalide : ${key}`);
        }
        if (typeof value !== "string") {
            throw new Error(`La valeur de ${key} doit être une chaîne de caractères.`);
        }
    }
    return variables as Record<string, string>;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
        console.log("Usage : update_lambda_env.exe <nom-ou-ARN-lambda> <fichier.json> [--dry-run]\nAjoute ou modifie les clés du JSON en conservant les autres variables.\nLes valeurs doivent être des chaînes. La mise à jour concerne $LATEST.");
        return;
    }
    const [functionName, file, ...options] = args;
    if (!functionName?.trim() || functionName.startsWith("-") || !file || file.startsWith("-") ||
        options.length > 1 || options.some(option => option !== "--dry-run")) {
        throw new Error("Usage : update_lambda_env.exe <nom-ou-ARN-lambda> <fichier.json> [--dry-run]");
    }
    // Refuse aliases/versions explicitly: only the unpublished configuration can be updated.
    if (!/^(?:arn:[a-z0-9-]+:lambda:[a-z0-9-]+:\d{12}:function:|\d{12}:function:)?[a-zA-Z0-9_-]+$/.test(functionName)) {
        throw new Error("Indiquer un nom ou ARN de Lambda sans alias ni numéro de version.");
    }
    const requested = loadVariables(file);
    for (const envPath of new Set([
        path.join(process.cwd(), ".env"),
        path.join(path.dirname(process.execPath), ".env"),
    ])) {
        if (existsSync(envPath)) dotenv.config({ path: envPath, override: true, quiet: true });
    }
    const client = new LambdaClient({ region: process.env.AWS_REGION });
    try {
        const current = await client.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
        if (current.Environment?.Error) {
            throw new Error("Impossible de lire les variables existantes de la Lambda (vérifier les droits KMS).");
        }
        const existing = current.Environment?.Variables ?? {};
        const changed = Object.keys(requested).filter(key => existing[key] !== requested[key]);
        if (!changed.length) {
            console.log("Aucune modification nécessaire.");
            return;
        }
        console.log(`Lambda : ${functionName}\nClés à ajouter/modifier : ${changed.join(", ")}`);
        if (options.includes("--dry-run")) {
            console.log("Dry-run : aucune modification appliquée. Les valeurs ne sont pas affichées.");
            return;
        }
        if (!current.RevisionId) throw new Error("RevisionId absent : mise à jour annulée.");
        await client.send(new UpdateFunctionConfigurationCommand({
            FunctionName: functionName,
            RevisionId: current.RevisionId,
            Environment: { Variables: { ...existing, ...requested } },
        }));
        await waitUntilFunctionUpdated({ client, maxWaitTime: 300 }, { FunctionName: functionName });
        console.log("Variables d'environnement mises à jour sur $LATEST.");
    } finally {
        client.destroy();
    }
}

if (require.main === module) {
    main().catch(error => {
        // SDK error messages can contain submitted environment values.
        const message = error instanceof Error && error.name === "Error"
            ? error.message
            : `Échec AWS (${error instanceof Error ? error.name : "erreur inconnue"}). Vérifier les droits, la région et l'état de la Lambda.`;
        console.error(message);
        process.exitCode = 1;
    });
}
