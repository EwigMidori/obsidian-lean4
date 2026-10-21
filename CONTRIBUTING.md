# Contributing

Issues and pull requests are welcome. Include reproduction steps, expected behavior, Obsidian version, operating system, and Lean version. Remove private note content from reports.

## Development

Use Node.js 22.12+ or 24+, then run:

```sh
npm ci
npm run check
```

Keep domain and application code independent of Obsidian and infrastructure. Each behavior belongs to an appropriate object; production module-level free functions are rejected by the architecture check. See [architecture](docs/architecture.md) and [validation](docs/validation.md).

Add focused regression tests for behavioral changes. Test UI changes in Obsidian as well as automated fixtures. Do not commit generated main.js, dependencies, vault data, or credentials.

## Releases

Update package.json, package-lock.json, manifest.json, versions.json and CHANGELOG.md together. Push a tag matching the manifest version exactly (for example `0.1.0`, without a `v` prefix). The workflow validates and creates a draft release with the plugin assets and license notices. Review it before publishing. Community plugin directory submission is a separate step.

Contributions are licensed under the project's MIT license.
