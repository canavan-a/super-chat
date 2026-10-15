import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {RoomListScreen} from '../src/screens/RoomListScreen';
import {ThemeProvider} from '../src/theme';

jest.useFakeTimers();

it('renders the room list with rooms (pixel field, pull, rows)', () => {
  const rooms = [
    {key: 'a', server: 's', id: '1', name: 'Alpha', color: '#4C8BF5', picture: null, unread: true, unreadCount: 3, preview: 'Bob: hi', lastAt: Date.now()},
    {key: 'b', server: 's', id: '2', name: 'Beta', color: '#34C759', picture: null, unread: false, unreadCount: 0, preview: null, lastAt: 0},
  ];
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ThemeProvider>
        <RoomListScreen rooms={rooms} loading={false} onNavigate={() => {}} />
      </ThemeProvider>,
    );
  });
  // lay out the pixel field so it draws its pixels
  act(() => {
    for (const v of tree.root.findAll(n => typeof n.props?.onLayout === 'function')) {
      v.props.onLayout({nativeEvent: {layout: {x: 0, y: 0, width: 400, height: 800}}});
    }
  });
  act(() => jest.advanceTimersByTime(2000));
  expect(tree.root.findAll(n => n.props?.children === 'Alpha').length).toBeGreaterThan(0);
  // the still constellation drew its pixels
  expect(tree.root.findAll(n => n.props?.style?.position === 'absolute' && n.props?.style?.opacity < 0.2).length).toBeGreaterThan(0);
  act(() => tree.unmount());
});
