# @zpcoder/ember-ops

Build/deploy orchestration for the seven repositories. Ops owns no gameplay rule, player data, or analytics transformation. Only version tuples registered in `compatibility/versions.json` may reach integration or production.

The seven entries in each `active` and `rollback` section select exact repository package releases (resolved as `v<version>` Git tags), including the Ops revision that executes the deployment. Public wire and immutable gameplay-data versions are independent: the corresponding `contracts.active` and `contracts.rollback` entries record the protocol line and pin the config version plus SHA-256 digest.
