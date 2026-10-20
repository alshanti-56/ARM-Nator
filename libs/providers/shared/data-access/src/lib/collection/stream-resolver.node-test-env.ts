// Imported before the Xtream library, whose player store reads this preference.
const previousLocalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage'
);
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
});

export function restoreNodeTestEnvironment(): void {
    if (previousLocalStorage) {
        Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    } else {
        Reflect.deleteProperty(globalThis, 'localStorage');
    }
}
