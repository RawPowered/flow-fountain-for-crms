# Product and compatibility versions

**Flow Fountain for CRMs** is the product name. Its current product release is **0.1.2**, published as Git tag `v0.1.2`. It remains a project preview.

`package.json` owns the package name `flow-fountain-for-crms` and semantic release version. The package lock and release manifest must match it. Archive filenames are derived from that package identity and version. The release checker blocks packaging when they disagree.

The database schema is a separate compatibility counter (currently **49**), and API route versions describe protocol contracts. Neither is the product version. GoHighLevel / LeadConnector is the original CRM integration; adapting other API-enabled CRMs requires integration work.

Flow Fountain and OSINT Dive Deep are separate products with independent release histories. Their versions do not need to match. Flow Fountain's earlier 0.1.0 release used its original project name; 0.1.1 introduced the current name. Historical tags and archives remain unchanged.

For future releases: update the package and lock versions, update the release manifest and current documentation, run the release checks and CI, then publish a matching `vMAJOR.MINOR.PATCH` tag and archive. Preserve historical release notes.
