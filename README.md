# Get Started

Create `.env` and get your infos from the `aws console login (click on generate keys)` for your temp credentials

```` bash
AWS_ACCESS_KEY_ID=""
AWS_SECRET_ACCESS_KEY=""
AWS_SESSION_TOKEN=""
AWS_REGION="eu-west-3"

````

```` bash
# Step 1 ( get lambda to update from Step Function )

# Will create lambdas_target.json ( double check the file if required )
npx tsx .\get_sfn_lambdas.ts "arn:aws:states:eu-west-3:..." "arn:aws:states:eu-west-3:..."

# Step 2 (manually) :  Add your ECR image (in the ecr_image key of your JSON) in the lambdas_target.json AND review the lambdas found.
code ./lambdas_target.json


# Step 3 Update lambda from lambdas_target.json
npx tsx .\update_lambdas.ts
````


# Compile

```` bash
scoop install bun

bun build get_sfn_lambdas.ts --compile --outfile get_sfn_lambdas.exe

bun build update_lambdas.ts --compile --outfile update_lambdas.exe


.\get_sfn_lambdas.exe "arn:aws:states:eu-west-3:..." "arn:aws:states:eu-west-3:..."

# Fill the JSON manually .. then run

.\update_lambdas.exe

````

```` bash 

# create lambdas_specific.json like :

# {
#     "lambdas": [
#         "arn:aws:lambda:eu-west-3:376411704273:function:test-gcm-cc-rc4-mod-1",
#         "arn:aws:lambda:eu-west-3:376411704273:function:test-gcm-cc-rc4-mod-2",
#         "arn:aws:lambda:eu-west-3:376411704273:function:test-gcm-cc-rc4-mod-3"

#     ],
#     "ecr_image": "376411704273.dkr.ecr.eu-west-3.amazonaws.com/gcs00/gcs-lambda-consistency-check-control@sha256:300322b6b42394bbb1e780264e6c530429944b4cac6834a5eeaa6686c83213d9"
# }

bun build update_specific_lambdas.ts --compile --outfile update_specific_lambdas.exe

.\update_specific_lambdas.exe

````