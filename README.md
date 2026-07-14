# npm-high-impact-deprecations

Finds "soft-deprecated" high-impact packages: npm packages whose READMEs announce a
deprecation, but which are **not** marked as deprecated on the npm registry itself.

These packages are effectively abandoned (the authors have said so in the docs), yet
nothing signals that to `npm install` or to tooling that reads registry metadata.

## Data

`deprecated.json` is a list of `{ name, reason, line }` for each package whose README
declares a deprecation, where `line` is the README line the notice was found on.

## Development

```sh
npm run generate        # download READMEs into readmes/
npm run find-deprecated # scan them and write deprecated.json
```

## License

MIT
