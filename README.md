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
# Téléchargement des logs JSON S3

Construire l'exécutable :

```powershell
npm run build:s3-downloader
```

Télécharger tous les fichiers JSON d'un préfixe S3 :

```powershell
.\s3_log_downloader.exe "/mod2/d9bd43ca-e943-4832-8421-c63ffdfb9f0c/"
```

Les fichiers sont placés par défaut dans `s3_logs/<dernier-segment>/`. Un autre dossier
peut être fourni en second argument. Le script utilise les identifiants AWS du
`.env` placé à côté de l'exécutable ou la chaîne d'identification AWS standard.

Le bucket par défaut est `test-gcm-lambdas-profiler`. Il peut être remplacé avec
`S3_BUCKET`.

# Création des Lambdas Consistency Check

Le script lit les CSV qui servent de source au module Terraform
`aws-gcm-consitancy-checks`. Il crée uniquement les Lambdas listées dans ces
CSV, et clone une Lambda existante de chaque type
(`control`, `rx12`, `loader`, `vloop`) et réutilise automatiquement son image ECR,
son rôle IAM, sa configuration VPC, sa mémoire, son timeout et ses variables
d'environnement. Il remplace ensuite le handler et les champs CSV propres à la
nouvelle Lambda, puis la crée directement avec le SDK AWS. Terraform n'est pas
utilisé.

Les Lambdas fixes `exception-unlocker`, `end-notification`, `clear-cache` et
`hide-report` ne sont pas touchées : elles sont déjà définies séparément dans
Terraform.

```powershell
npx tsx .\generate_consistency_check_lambdas.ts test --apply `
	--template-control test-gcm-cc-lp1-1 `
	--template-rx12 test-gcm-cc-rm12-1-1 `
	--template-loader test-gcm-cc-context-loader `
	--template-vloop test-gcm-cc-vloop-loader
```

Les arguments `--template-*` peuvent être des noms ou des ARN de Lambdas déjà
existantes dans le même compte/région. Ils sont importants : ils servent de
modèles pour reproduire exactement la configuration réellement déployée.

Pour créer uniquement les Lambdas `control`, ajoute `--only control`. Le script
ne lira alors que `gcm_cc_control_list.csv` et ne demandera que le modèle control :

```powershell
npx tsx .\generate_consistency_check_lambdas.ts test --only control --apply `
	--template-control test-gcm-cc-lp1-1
```

Pour créer uniquement `CONTEXT_LOADER` avec un nom personnalisé :

```powershell
npx tsx .\generate_consistency_check_lambdas.ts dev --only loader `
	--csv-id CONTEXT_LOADER `
	--function-name dev-gcm-consistencychecks-loader-context-form `
	--apply `
	--template-loader dev-gcm-cc-context-loader
```

Sans `--apply`, le script fait seulement un dry-run et ne crée rien. Le résultat
est écrit dans `consistency_check_lambdas_test.json` et contient les ARN créés.
Les clés d'environnement sensibles sont masquées dans le JSON par défaut. Pour
un usage local contrôlé :

```powershell
npx tsx .\generate_consistency_check_lambdas.ts test --include-sensitive
```

Options disponibles : `--csv-dir <path>` et `--output <path>`.

Version compilée :

```powershell
npm run build:consistency-check
.\generate_consistency_check_lambdas.exe test
```


```` powershell 

npx tsx .\generate_consistency_check_lambdas.ts <test|stg|prd|dev...> --apply --template-control test-gcm-cc-lp1-1 --template-rx12 test-gcm-cc-rm12-1-1 --template-loader test-gcm-cc-context-loader --template-vloop test-gcm-cc-vloop-loader

# npx tsx .\generate_consistency_check_lambdas.ts test --only control --apply --template-control test-gcm-cc-lp1-1

npx tsx .\generate_consistency_check_lambdas.ts test --only loader --apply --template-loader test-gcm-cc-context-loader

````
