export default {
    displayName: 'providers-xtream-feature',
    preset: '../../../../jest.preset.js',
    setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
    testMatch: ['**/*.integration.spec.ts'],
    coverageDirectory: '../../../../coverage/libs/providers/xtream/feature',
};
