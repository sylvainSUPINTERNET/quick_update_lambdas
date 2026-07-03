import fs from "node:fs";
import {
    DescribeStateMachineCommand,
    SFNClient,
} from "@aws-sdk/client-sfn";

import dotenv from "dotenv";
dotenv.config();

function findLambdas(states: any, result: any[] = []) {
    for (const state of Object.values(states)) {
        if ((state as any).Type === "Task") {
            // Ancien format
            if (
                (state as any).Resource?.includes(":lambda:") &&
                (state as any).Resource?.includes(":function:")
            ) {
                result.push((state as any).Resource);
            }

            // Nouveau format SDK
            if ((state as any).Arguments?.FunctionName) {
                result.push((state as any).Arguments.FunctionName);
            }

            // Format Parameters
            if ((state as any).Parameters?.FunctionName) {
                result.push((state as any).Parameters.FunctionName);
            }
        }

        if ((state as any).Branches) {
            for (const branch of (state as any).Branches) {
                findLambdas(branch.States, result);
            }
        }

        if ((state as any).Iterator) {
            findLambdas((state as any).Iterator.States, result);
        }
    }

    return result;
}

(async () => {
    const ARN_SFNS = process.argv.slice(2);

    if (ARN_SFNS.length === 0) {
        console.error(
            "Usage: npx tsx main.ts <ARN_SFN1> [ARN_SFN2] [ARN_SFN3] ..."
        );
        process.exit(1);
    }

    console.log("Using AWS REGION:", process.env.AWS_REGION);

    const client = new SFNClient({
        region: process.env.AWS_REGION ?? "eu-west-3",
    });

    try {
        const result: Record<
            string,
            {
                lambdas: string[];
                ecr_image: string;
            }
        > = {};

        for (const arn of ARN_SFNS) {
            console.log(`\nProcessing Step Function: ${arn}`);

            const res = await client.send(
                new DescribeStateMachineCommand({
                    stateMachineArn: arn,
                })
            );

            if (!res.definition) {
                throw new Error(`Unable to retrieve definition for ${arn}`);
            }

            const definition = JSON.parse(res.definition);

            const lambdas = [...new Set(findLambdas(definition.States))];

            console.log(`Found ${lambdas.length} lambda(s)`);

            result[arn] = {
                lambdas,
                ecr_image: "<to_add>",
            };
        }

        console.log(result);

        const saveFile = "./lambdas_target.json";

        fs.writeFile(
            saveFile,
            JSON.stringify(result, null, 4),
            (err) => {
                if (err) {
                    console.error(err);
                    return;
                }

                console.log(`\nLambdas list saved to ${saveFile}`);
                console.log(
                    "-- Edit this file before launching the lambda update script! --"
                );
            }
        );
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();