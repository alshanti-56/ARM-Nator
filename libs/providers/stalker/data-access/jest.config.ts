export default {
    displayName: 'portal-stalker-data-access',
    preset: '../../../../jest.preset.js',
    setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
    testPathIgnorePatterns: [
        '/node_modules/',
        '<rootDir>/src/lib/stalker-category-counts.spec.ts',
        '<rootDir>/src/lib/stalker-category-visibility.spec.ts',
    ],
    coverageDirectory: '../../../../coverage/libs/portal/stalker/data-access',
};
