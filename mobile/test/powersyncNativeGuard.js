// Mapped over @powersync/react-native and @op-engineering/op-sqlite in
// jest.config.js. No unit test may load native PowerSync code — reads are
// tested through the LocalReads seam (lib/data/reads/source.ts). If this
// throws, some import chain reached mobile/powersync/db.ts: break the chain,
// don't mock deeper.
throw new Error(
  "A test imported native PowerSync code. Test through the LocalReads seam " +
    "(setLocalReads) instead — see mobile/lib/data/reads/source.ts."
);
