// Test-only entry point: player preferences are read while Angular libraries load.
const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
});

export function restoreNodeTestEnvironment(): void {
    if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
}
