import fs from "node:fs";
import dotenv from "dotenv";
import {
    LambdaClient,
    UpdateFunctionCodeCommand,
    waitUntilFunctionUpdated,
} from "@aws-sdk/client-lambda";

dotenv.config();

if (!fs.existsSync("./lambdas_target.json")) {
    console.error("❌ First run `get_sfn_lambdas.ts` to generate the lambdas_target.json file!");
    process.exit(1);
}

const config = JSON.parse(
    fs.readFileSync("./lambdas_target.json", "utf8")
) as Record<
    string,
    {
        lambdas: string[];
        ecr_image: string;
    }
>;

const client = new LambdaClient({
    region: process.env.AWS_REGION,
});

async function updateLambda(lambdaArn: string, imageUri: string) {
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

(async () => {
    let total = 0;

    for (const [sfnArn, { lambdas, ecr_image }] of Object.entries(config)) {
        if (!ecr_image) {
            console.warn(`⚠️ No ECR image configured for ${sfnArn}, skipping.`);
            continue;
        }

        console.log(`\n📦 ${sfnArn}`);
        console.log(`Using image: ${ecr_image}`);
        console.log(`Updating ${lambdas.length} Lambda(s)...`);

        await Promise.all(
            lambdas.map(lambda => updateLambda(lambda, ecr_image))
        );

        total += lambdas.length;
    }

    console.log(`\n🎉 Successfully updated ${total} Lambda(s).`);
})();