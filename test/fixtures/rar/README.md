# RAR test fixtures

Small archives used by `test/core/parse/rarLoader.test.ts` to exercise the
RAR loader end-to-end.

## Files

- `FolderTest.rar` — 5.6 kB RAR4 archive containing a small nested folder
  layout. Sourced from the MIT-licensed `node-unrar.js` project
  (`testFiles/FolderTest.rar`, upstream repo `YuJianrong/node-unrar.js`).
  Contains no credentials, no customer data, no RabbitMQ topology.

Do **not** put real topology exports here. Raw customer archives belong in
`data/raw/`, which is git-ignored.
