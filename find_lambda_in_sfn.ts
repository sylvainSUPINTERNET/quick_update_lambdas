import dotenv from "dotenv";
import {
    DescribeStateMachineCommand,
    ListStateMachinesCommand,
    SFNClient,
} from "@aws-sdk/client-sfn";

dotenv.config();

function getRegionFromLambdaArn(lambdaArn: string): string | undefined {
    const parts = lambdaArn.split(":");

    if (parts.length < 7 || parts[0] !== "arn" || parts[2] !== "lambda") {
        return undefined;
    }

    return parts[3];
}

function isLambdaArn(value: string): boolean {
    return /^arn:[^:]+:lambda:[^:]+:\d{12}:function:[^:]+(?::[^:]+)?$/.test(
        value
    );
}

async function findStateMachinesUsingLambda(
    client: SFNClient,
    lambdaArn: string
): Promise<string[]> {
    const stateMachineArns: string[] = [];
    let nextToken: string | undefined;

    do {
        const response = await client.send(
            new ListStateMachinesCommand({ nextToken })
        );

        for (const stateMachine of response.stateMachines ?? []) {
            if (stateMachine.stateMachineArn) {
                stateMachineArns.push(stateMachine.stateMachineArn);
            }
        }

        nextToken = response.nextToken;
    } while (nextToken);

    const matches: string[] = [];

    for (const stateMachineArn of stateMachineArns) {
        try {
            const response = await client.send(
                new DescribeStateMachineCommand({ stateMachineArn })
            );

            // Recherche volontairement dans le JSON brut : cela couvre aussi bien
            // Resource que Parameters/Arguments et les états imbriqués.
            if (response.definition?.includes(lambdaArn)) {
                matches.push(stateMachineArn);
                console.log(`Use by -> ${stateMachineArn}`);
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            console.warn(`Error : ${stateMachineArn}: ${message}`);
        }
    }

    return matches;
}

async function main(): Promise<void> {
    const lambdaArn = process.argv[2];

    if (!lambdaArn || !isLambdaArn(lambdaArn)) {
        console.error(
            "Usage: npx tsx find_lambda_in_sfn.ts <ARN_LAMBDA>"
        );
        console.error(
            "Example: npx tsx find_lambda_in_sfn.ts arn:aws:lambda:eu-west-3:123456789012:function:my-lambda"
        );
        process.exitCode = 1;
        return;
    }

    const region = process.env.AWS_REGION ?? getRegionFromLambdaArn(lambdaArn);
    const client = new SFNClient({ region });

    console.log(`Searching in Step Functions in region ${region}...`);

    const matches = await findStateMachinesUsingLambda(client, lambdaArn);

    if (matches.length === 0) {
        console.log(`No Step Function uses ${lambdaArn}.`);
    } else {
        console.log(`\n${matches.length} Step Function(s) found.`);
    }
}

main().catch((error) => {
    console.error("The search failed:", error);
    process.exitCode = 1;
});
