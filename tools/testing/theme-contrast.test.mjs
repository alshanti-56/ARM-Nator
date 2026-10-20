import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const buildRequire = createRequire(
    require.resolve('@angular/build/package.json'),
);
const sass = buildRequire('sass');
const postcss = buildRequire('postcss');
const css = postcss.parse(
    sass.compile(`${root}apps/desktop-ui/src/m3-theme.scss`, {
        loadPaths: [`${root}node_modules`],
        logger: sass.Logger.silent,
    }).css,
);

function tokens(selector) {
    const values = {};
    css.walkRules(selector, (rule) =>
        rule.walkDecls(/^--/, (decl) => {
            values[decl.prop] = decl.value;
        }),
    );
    return values;
}

function luminance(hex) {
    assert.match(hex, /^#[0-9a-f]{6}$/i);
    const rgb = hex
        .slice(1)
        .match(/../g)
        .map((channel) => {
            const value = parseInt(channel, 16) / 255;
            return value <= 0.04045
                ? value / 12.92
                : ((value + 0.055) / 1.055) ** 2.4;
        });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function contrast(foreground, background) {
    const values = [luminance(foreground), luminance(background)].sort(
        (a, b) => b - a,
    );
    return (values[0] + 0.05) / (values[1] + 0.05);
}

test('both themes emit the Material system colors used by shared components', () => {
    for (const selector of ['html', 'html .dark-theme']) {
        const values = tokens(selector);
        for (const name of [
            'surface',
            'on-surface',
            'surface-container',
            'outline-variant',
            'error',
        ]) {
            assert.ok(
                values[`--mat-sys-${name}`],
                `${selector}: missing --mat-sys-${name}`,
            );
        }
        assert.ok(
            contrast(
                values['--mat-sys-on-surface'],
                values['--mat-sys-surface'],
            ) >= 4.5,
        );
    }
});

test('light theme secondary text and filled actions have readable contrast', () => {
    const values = tokens('html');
    for (const text of ['heading', 'body', 'muted', 'eyebrow']) {
        for (const surface of ['content-bg', 'widget-bg', 'rail-bg']) {
            const ratio = contrast(
                values[`--app-${text}-color`],
                values[`--app-${surface}`],
            );
            assert.ok(
                ratio >= 4.5,
                `${text} on ${surface}: ${ratio.toFixed(2)}:1`,
            );
        }
    }
    assert.ok(
        contrast(
            values['--app-selection-on-color'],
            values['--app-selection-color'],
        ) >= 4.5,
    );
});
