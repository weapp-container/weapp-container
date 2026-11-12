App({ globalData: { sequence: 0, instances: 0, retired: null, journal: { schemaVersion: 1, events: [], geometries: [] } }, onLaunch() { throw new Error('P0_CANDIDATE_STARTUP_FAILURE'); } });
