import fs from "node:fs";
import dotenv from "dotenv";
import {
    LambdaClient,
    UpdateFunctionCodeCommand,
    waitUntilFunctionUpdated,
} from "@aws-sdk/client-lambda";

dotenv.config();

type Config = {
    lambdas: string[];
    ecr_image: string;
};

const configFile = "./lambdas_specific.json";

function loadConfig(file: string): Config {
    if (!fs.existsSync(file)) {
        throw new Error(
            `Configuration file not found: ${file}\n` +
            "Expected format: { \"lambdas\": [\"<lambda ARN>\"], \"ecr_image\": \"<ECR image URI>\" }"
        );
    }

    const config: unknown = JSON.parse(fs.readFileSync(file, "utf8"));

    if (!config || typeof config !== "object") {
        throw new Error(`Invalid configuration in ${file}: expected a JSON object.`);
    }

    const { lambdas, ecr_image } = config as Partial<Config>;

    if (
        !Array.isArray(lambdas) ||
        lambdas.length === 0 ||
        lambdas.some(lambda => typeof lambda !== "string" || !lambda.trim())
    ) {
        throw new Error(
            `Invalid configuration in ${file}: "lambdas" must be a non-empty array of Lambda ARNs.`
        );
    }

    if (typeof ecr_image !== "string" || !ecr_image.trim()) {
        throw new Error(
            `Invalid configuration in ${file}: "ecr_image" must contain the ECR image URI.`
        );
    }

    return { lambdas, ecr_image };
}

const client = new LambdaClient({
    region: process.env.AWS_REGION,
});

async function updateLambda(lambdaArn: string, imageUri: string): Promise<void> {
    console.log(`🚀 Updating ${lambdaArn}...`);

    await client.send(
        new UpdateFunctionCodeCommand({
            FunctionName: lambdaArn,
            ImageUri: imageUri,
            Publish: false,
        })
    );

    await waitUntilFunctionUpdated(
        {
            client,
            maxWaitTime: 300,
        },
        {
            FunctionName: lambdaArn,
        }
    );

    console.log(`✅ Updated ${lambdaArn}`);
}

async function main(): Promise<void> {
    const { lambdas, ecr_image } = loadConfig(configFile);

    console.log(`Using image: ${ecr_image}`);
    console.log(`Updating ${lambdas.length} Lambda(s)...`);

    await Promise.all(
        lambdas.map(lambda => updateLambda(lambda, ecr_image))
    );

    console.log(`\n🎉 Successfully updated ${lambdas.length} Lambda(s).`);
}

main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${message}`);
    process.exitCode = 1;
});
