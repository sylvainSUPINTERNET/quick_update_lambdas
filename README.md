```` bash
# Step 1 ( get lambda to update from Step Function )

# Will create lambdas_target.json ( double check the file if required )
npx tsx .\get_sfn_lambdas.ts "arn:aws:states:eu-west-3:376411704273:stateMachine:poc-gcm-ccheck-technical-physical-quantity" "arn:aws:states:eu-west-3:376411704273:stateMachine:poc-gcm-ccheck-homologation-physical-quantity"

code ./lambdas_target.json


# Step 2 (manually) :  Add ECR image in the lambdas_target.json

# Step 3 Update lambda from lambdas_target.json ( using your ECR images set in your JSON )
npx tsx .\update_lambdas.ts

````