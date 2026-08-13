const fs = require('node:fs');
const path = require('node:path');
const angularPreset = require('jest-preset-angular/jest-preset');

const workspaceRoot = __dirname;
const tsconfig = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, 'tsconfig.base.json'), 'utf8')
);

const moduleNameMapper = Object.fromEntries(
    Object.entries(tsconfig.compilerOptions.paths).map(([alias, targets]) => [
        `^${alias}$`,
        path.resolve(workspaceRoot, targets[0]),
    ])
);

module.exports = {
    ...angularPreset,
    moduleNameMapper,
};
