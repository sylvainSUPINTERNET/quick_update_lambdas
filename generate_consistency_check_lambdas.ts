import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
    CreateFunctionCommand,
    GetFunctionCommand,
    LambdaClient,
    ListTagsCommand,
    TagResourceCommand,
} from "@aws-sdk/client-lambda";

dotenv.config();

type LambdaDefinition = {
    category: string;
    source: string;
    csv: string[];
    functionName: string;
};

type LambdaResult = LambdaDefinition & {
    status: "found" | "missing";
    arn: string | null;
    role: string | null;
    imageUri: string | null;
    memorySize: number | null;
    timeout: number | null;
    environment: Record<string, string>;
    error?: string;
};

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultCsvDirectory = path.resolve(
    scriptDirectory,
    "../../aws-ops/modules/aws-gcm-consitancy-checks/csvs"
);

const sensitiveEnvironmentKey = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential)/i;

function parseArguments(): {
    workspace: string;
    csvDirectory: string;
    outputFile: string;
    includeSensitive: boolean;
    apply: boolean;
    only: string[];
    csvId?: string;
    functionName?: string;
    templates: Record<string, string>;
} {
    const argumentsList = process.argv.slice(2);
    const workspace = argumentsList.find(argument => !argument.startsWith("--"));

    if (!workspace) {
        throw new Error(
            "Usage: npx tsx generate_consistency_check_lambdas.ts <workspace> [--include-sensitive] [--csv-dir <path>] [--output <path>]"
        );
    }

    const optionValue = (option: string): string | undefined => {
        const index = argumentsList.indexOf(option);
        return index >= 0 ? argumentsList[index + 1] : undefined;
    };

    const only = optionValue("--only")
        ?.split(",")
        .map(category => category.trim().toLowerCase())
        .filter(Boolean) ?? ["control", "rx12", "loader", "vloop"];
    const validCategories = new Set(["control", "rx12", "loader", "vloop"]);
    const invalidCategory = only.find(category => !validCategories.has(category));

    if (invalidCategory) {
        throw new Error(
            `Invalid --only value: ${invalidCategory}. Use control, rx12, loader or vloop.`
        );
    }

    return {
        workspace,
        csvDirectory: path.resolve(
            optionValue("--csv-dir") ?? defaultCsvDirectory
        ),
        outputFile: path.resolve(
            optionValue("--output") ?? `consistency_check_lambdas_${workspace}.json`
        ),
        includeSensitive: argumentsList.includes("--include-sensitive"),
        apply: argumentsList.includes("--apply"),
        only,
        csvId: optionValue("--csv-id"),
        functionName: optionValue("--function-name"),
        templates: {
            control: optionValue("--template-control") ?? "",
            rx12: optionValue("--template-rx12") ?? "",
            loader: optionValue("--template-loader") ?? "",
            vloop: optionValue("--template-vloop") ?? "",
        },
    };
}

function readCsvDefinitions(
    csvDirectory: string,
    workspace: string
): LambdaDefinition[] {
    const csvFiles = [
        {
            category: "control",
            file: "gcm_cc_control_list.csv",
            fields: 3,
        },
        {
            category: "loader",
            file: "gcm_cc_loader_list.csv",
            fields: 2,
        },
        {
            category: "vloop",
            file: "gcm_cc_vloop_list.csv",
            fields: 2,
        },
        {
            category: "rx12",
            file: "gcm_cc_rx12_mod123_list.csv",
            fields: 5,
        },
    ];

    return csvFiles.flatMap(({ category, file, fields }) => {
        const csvPath = path.join(csvDirectory, file);

        if (!fs.existsSync(csvPath)) {
            throw new Error(`CSV file not found: ${csvPath}`);
        }

        return fs
            .readFileSync(csvPath, "utf8")
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => line.split(";"))
            .filter(fieldsFromLine => fieldsFromLine.length === fields)
            .map(fieldsFromLine => ({
                category,
                source: file,
                csv: fieldsFromLine,
                functionName: `${workspace}-gcm-cc-${fieldsFromLine[0]
                    .toLowerCase()
                    .replace(/_/g, "-")}`,
            }));
    });
}

function redactEnvironment(
    variables: Record<string, string> | undefined,
    includeSensitive: boolean
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(variables ?? {}).map(([key, value]) => [
            key,
            includeSensitive || !sensitiveEnvironmentKey.test(key)
                ? value
                : "<redacted>",
        ])
    );
}

async function getLambda(
    client: LambdaClient,
    definition: LambdaDefinition,
    includeSensitive: boolean
): Promise<LambdaResult> {
    try {
        const response = await client.send(
            new GetFunctionCommand({ FunctionName: definition.functionName })
        );
        const configuration = response.Configuration;

        return {
            ...definition,
            status: "found",
            arn: configuration?.FunctionArn ?? null,
            role: configuration?.Role ?? null,
            imageUri: response.Code?.ImageUri ?? null,
            memorySize: configuration?.MemorySize ?? null,
            timeout: configuration?.Timeout ?? null,
            environment: redactEnvironment(
                configuration?.Environment?.Variables,
                includeSensitive
            ),
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
            ...definition,
            status: "missing",
            arn: null,
            role: null,
            imageUri: null,
            memorySize: null,
            timeout: null,
            environment: {},
            error: message,
        };
    }
}

function getTemplateForCategory(
    definitions: LambdaDefinition[],
    category: string,
    templates: Record<string, string>
): { category: string; functionName: string } {
    const configuredTemplate = templates[category];

    if (configuredTemplate) {
        return { category, functionName: configuredTemplate };
    }

    const existingDefinition = definitions.find(
        definition => definition.category === category
    );

    if (!existingDefinition) {
        throw new Error(
            `No template configured for ${category}. Use --template-${category} <existing Lambda name or ARN>.`
        );
    }

    return { category, functionName: existingDefinition.functionName };
}

function environmentForNewLambda(
    definition: LambdaDefinition,
    environment: Record<string, string>
): Record<string, string> {
    const updated = { ...environment };
    updated.QUARKUS_LAMBDA_HANDLER = definition.csv[1];

    if (definition.category === "control" || definition.category === "rx12") {
        updated.RUN_SCOPE = definition.csv[2];
    }

    if (definition.category === "rx12") {
        updated.BATCH_NUMBER = definition.csv[3];
        updated.BATCHS_TOTAL_EXPECTED = definition.csv[4];
    }

    return updated;
}

async function createFromTemplate(
    client: LambdaClient,
    definition: LambdaDefinition,
    template: Awaited<ReturnType<typeof client.send>>,
    includeSensitive: boolean
): Promise<LambdaResult> {
    const configuration = template.Configuration;
    const imageUri = template.Code?.ImageUri;

    if (!configuration?.Role || !imageUri) {
        throw new Error(
            `Template ${definition.category} is missing its IAM role or image URI.`
        );
    }

    const environment = environmentForNewLambda(
        definition,
        configuration.Environment?.Variables ?? {}
    );
    const created = await client.send(
        new CreateFunctionCommand({
            FunctionName: definition.functionName,
            PackageType: "Image",
            Role: configuration.Role,
            Code: { ImageUri: imageUri },
            Description: configuration.Description,
            Timeout: configuration.Timeout,
            MemorySize: configuration.MemorySize,
            EphemeralStorage: configuration.EphemeralStorage,
            Environment: { Variables: environment },
            VpcConfig: configuration.VpcConfig
                ? {
                      SecurityGroupIds:
                          configuration.VpcConfig.SecurityGroupIds,
                      SubnetIds: configuration.VpcConfig.SubnetIds,
                  }
                : undefined,
            Architectures: configuration.Architectures,
            KMSKeyArn: configuration.KMSKeyArn,
            Publish: false,
        })
    );

    if (created.FunctionArn) {
        const templateTags = template.Configuration?.FunctionArn
            ? await client.send(
                  new ListTagsCommand({
                      Resource: template.Configuration.FunctionArn,
                  })
              )
            : undefined;

        if (templateTags?.Tags && Object.keys(templateTags.Tags).length > 0) {
            await client.send(
                new TagResourceCommand({
                    Resource: created.FunctionArn,
                    Tags: templateTags.Tags,
                })
            );
        }
    }

    return {
        ...definition,
        status: "found",
        arn: created.FunctionArn ?? null,
        role: configuration.Role,
        imageUri,
        memorySize: configuration.MemorySize ?? null,
        timeout: configuration.Timeout ?? null,
        environment: redactEnvironment(environment, includeSensitive),
    };
}

async function main(): Promise<void> {
    const {
        workspace,
        csvDirectory,
        outputFile,
        includeSensitive,
        apply,
        only,
        csvId,
        functionName,
        templates,
    } =
        parseArguments();
    const region = process.env.AWS_REGION ?? "eu-west-3";
    const definitions = readCsvDefinitions(csvDirectory, workspace)
        .filter(definition => only.includes(definition.category))
        .filter(definition => !csvId || definition.csv[0] === csvId);

    if (definitions.length === 0) {
        throw new Error("No Lambda definition matched --only/--csv-id.");
    }

    if (functionName) {
        if (definitions.length !== 1) {
            throw new Error(
                "--function-name requires exactly one Lambda. Use --csv-id to select one CSV entry."
            );
        }
        definitions[0].functionName = functionName;
    }
    const client = new LambdaClient({ region });
    const lambdas: LambdaResult[] = [];

    console.log(`Reading ${definitions.length} consistency-check Lambda(s)...`);
    console.log(`Workspace: ${workspace}`);
    console.log(`AWS region: ${region}`);

    if (!apply) {
        console.log("Dry run: no Lambda will be created. Add --apply to create them.");
    }

    const templateResponses = new Map<string, Awaited<ReturnType<typeof client.send>>>();
    for (const category of only) {
        const template = getTemplateForCategory(definitions, category, templates);
        const response = await client.send(
            new GetFunctionCommand({ FunctionName: template.functionName })
        );
        templateResponses.set(category, response);
        console.log(`Template ${category}: ${template.functionName}`);
    }

    for (const definition of definitions) {
        try {
            if (!apply) {
                const template = templateResponses.get(definition.category);
                const imageUri = template?.Code?.ImageUri ?? null;
                lambdas.push({
                    ...definition,
                    status: "missing",
                    arn: null,
                    role: template?.Configuration?.Role ?? null,
                    imageUri,
                    memorySize: template?.Configuration?.MemorySize ?? null,
                    timeout: template?.Configuration?.Timeout ?? null,
                    environment: redactEnvironment(
                        environmentForNewLambda(
                            definition,
                            template?.Configuration?.Environment?.Variables ?? {}
                        ),
                        includeSensitive
                    ),
                });
                console.log(`⏭️  Would create ${definition.functionName}`);
                continue;
            }

            const existing = await getLambda(client, definition, includeSensitive);
            if (existing.status === "found") {
                lambdas.push(existing);
                console.log(`⏭️  Already exists: ${definition.functionName}`);
                continue;
            }

            const template = templateResponses.get(definition.category);
            if (!template) {
                throw new Error(`Missing template response for ${definition.category}`);
            }

            const result = await createFromTemplate(
                client,
                definition,
                template,
                includeSensitive
            );
            lambdas.push(result);
            console.log(`✅ Created ${definition.functionName}: ${result.arn}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            lambdas.push({
                ...definition,
                status: "missing",
                arn: null,
                role: null,
                imageUri: null,
                memorySize: null,
                timeout: null,
                environment: {},
                error: message,
            });
            console.error(`❌ ${definition.functionName}: ${message}`);
        }
    }

    const output = {
        generatedAt: new Date().toISOString(),
        workspace,
        region,
        csvDirectory,
        sensitiveValuesIncluded: includeSensitive,
        applied: apply,
        lambdas,
    };

    fs.writeFileSync(outputFile, `${JSON.stringify(output, null, 4)}\n`, "utf8");

    const found = lambdas.filter(lambda => lambda.status === "found").length;
    console.log(`\nSaved ${found}/${lambdas.length} Lambda(s) to ${outputFile}`);
}

main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${message}`);
    process.exitCode = 1;
});