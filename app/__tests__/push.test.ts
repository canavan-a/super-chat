import {NativeModules} from 'react-native';

const mockNative = {
  isAvailable: jest.fn(async () => true),
  subscribe: jest.fn(async (_t: string) => {}),
  unsubscribe: jest.fn(async (_t: string) => {}),
  clearLocked: jest.fn(),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
(NativeModules as any).Push = mockNative;

let mockRooms: {key: string; id: string}[] = [];
jest.mock('../src/store', () => ({
  roomList: () => mockRooms,
  subscribe: () => () => {},
  catchUp: jest.fn(async () => {}),
}));

const {roomTopic, syncTopics} = require('../src/push');
const AsyncStorage = require('@react-native-async-storage/async-storage');

describe('push topics', () => {
  it('match the server (server/push/push_test.go uses the same vector)', () => {
    expect(roomTopic('AAAAAAAAAAAAAAAAAAAAAA')).toBe(
      'sc-tPhg4JHeTEob8sBpQDmd0A',
    );
    // FCM topic names: [a-zA-Z0-9-_.~%]+
    expect(roomTopic('some-room-id')).toMatch(/^sc-[A-Za-z0-9_-]+$/);
  });

  it('follow the rooms this device is in', async () => {
    await AsyncStorage.clear();
    mockRooms = [
      {key: 's|a', id: 'room-a'},
      {key: 's|b', id: 'room-b'},
    ];
    await syncTopics();
    expect(mockNative.subscribe.mock.calls.map(c => c[0]).sort()).toEqual(
      [roomTopic('room-a'), roomTopic('room-b')].sort(),
    );

    // Left room a, joined c: unsubscribe a, subscribe c, leave b alone.
    mockNative.subscribe.mockClear();
    mockRooms = [
      {key: 's|b', id: 'room-b'},
      {key: 's|c', id: 'room-c'},
    ];
    await syncTopics();
    expect(mockNative.subscribe.mock.calls.map(c => c[0])).toEqual([
      roomTopic('room-c'),
    ]);
    expect(mockNative.unsubscribe.mock.calls.map(c => c[0])).toEqual([
      roomTopic('room-a'),
    ]);
  });

  it('retries a subscription that failed', async () => {
    await AsyncStorage.clear();
    mockNative.subscribe.mockClear();
    mockRooms = [{key: 's|a', id: 'room-a'}];
    mockNative.subscribe.mockRejectedValueOnce(new Error('offline'));
    await syncTopics();
    await syncTopics();
    expect(mockNative.subscribe).toHaveBeenCalledTimes(2);
  });
});
