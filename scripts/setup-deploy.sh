#!/usr/bin/env bash
# One-time: lets GitHub Actions deploy tritone-site. Run on a Mac logged into gcloud + gh as Scott.
set -euo pipefail
P=tritone-site
SA=github-deployer@$P.iam.gserviceaccount.com
gcloud iam service-accounts describe "$SA" --project $P >/dev/null 2>&1 \
  || gcloud iam service-accounts create github-deployer --project $P --display-name "GitHub deploys"
for role in roles/firebasehosting.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $P --member "serviceAccount:$SA" --role $role --condition=None >/dev/null
done
KEY=$(mktemp)
gcloud iam service-accounts keys create "$KEY" --iam-account "$SA" --project $P
gh secret set FIREBASE_SERVICE_ACCOUNT -R slarson36251-hub/tritone-site < "$KEY"
rm -f "$KEY"
gh variable set MUSIC_CALENDAR_ID -R slarson36251-hub/tritone-site --body "226gr9pmhmg1mcrfmm1fre0nf4@group.calendar.google.com"
echo "Done. Every push to main now deploys."
