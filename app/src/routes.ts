// Hand-rolled routing: react-navigation drags in native-only deps
// (react-native-screens/gesture-handler/reanimated) that complicate the
// react-native-web/Vite target for a handful of screens, so App.tsx just
// switches on this union instead.
export type Route =
  | {name: 'home'}
  | {name: 'room'; key: string}
  | {name: 'roomSettings'; key: string}
  | {name: 'newRoom'}
  | {name: 'join'; link?: string}
  | {name: 'settings'}
  | {name: 'voice'; key: string}
  | {name: 'privacy'}
  | {name: 'terms'};
