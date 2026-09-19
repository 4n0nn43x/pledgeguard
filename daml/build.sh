#!/bin/sh
# Builds every DAR and runs the scenario test. Needs dpm 1.0.22 with SDK 3.5.8 and 3.4.11.
set -e
cd "$(dirname "$0")"
(cd pledgeguard-test && dpm build && dpm test)
(cd vendor/governance-action-v1 && dpm build --enable-multi-package=no)
(cd pledgeguard-governance && dpm build --enable-multi-package=no)
ls -1 */.daml/dist/*.dar vendor/*/.daml/dist/*.dar
