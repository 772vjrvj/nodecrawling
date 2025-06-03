let store;

(async () => {
    const { default: Store } = await import('electron-store');
    store = new Store();
})();

module.exports = {
    set: (key, value) => store?.set?.(key, value),
    get: (key) => store?.get?.(key)
};