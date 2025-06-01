//store.js
// electron-store 기본 설정
const Store = require('electron-store').default;

// Store 인스턴스 생성
const store = new Store();

// 외부에서 store.set(), store.get()으로 사용 가능
module.exports = store;