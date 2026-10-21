# repos/ — the repos this box serves

One `<name>.env` per target, holding `REPO_PATH=/abs/path/to/its/checkout` and
nothing else. The files are not tracked (`.gitignore`): they are this
machine's registry, not the fleet's code. A new box makes its own.
