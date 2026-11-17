import {parseMarkdown} from '../src/markdown';
import {encodeMentions, matchMembers, mentionQuery, mentionsToNames} from '../src/mentions';

const ann = {id: 'a'.repeat(52), name: 'Ann'};
const annLee = {id: 'b'.repeat(52), name: 'Ann Lee'};
const bob = {id: 'c'.repeat(52), name: 'Bob'};
const members = [ann, annLee, bob];
const nameOf = (id: string) => members.find(m => m.id === id)?.name ?? '?';

test('encodes typed names as member IDs, longest name first, at word boundaries', () => {
  expect(encodeMentions('hi @Ann Lee and @Ann!', members)).toBe(`hi <@${annLee.id}> and <@${ann.id}>!`);
  expect(encodeMentions('@Annabel me@Bob @bob', members)).toBe('@Annabel me@Bob @bob');
});

test('a pick settles two members with one name', () => {
  const twin = {id: 'd'.repeat(52), name: 'Bob'};
  expect(encodeMentions('@Bob', [...members, twin], {Bob: twin.id})).toBe(`<@${twin.id}>`);
});

test('round-trips through names', () => {
  const text = 'yo @Ann Lee, ask @Bob';
  expect(mentionsToNames(encodeMentions(text, members), nameOf)).toBe(text);
});

test('finds the @query before the cursor', () => {
  expect(mentionQuery('hey @an', 7)).toEqual({start: 4, query: 'an'});
  expect(mentionQuery('@', 1)).toEqual({start: 0, query: ''});
  expect(mentionQuery('a@b', 3)).toBeNull();
  expect(mentionQuery('@Ann ', 5)).toBeNull();
});

test('matches any word of a name', () => {
  expect(matchMembers(members, 'lee').map(m => m.name)).toEqual(['Ann Lee']);
  expect(matchMembers(members, 'an').map(m => m.name)).toEqual(['Ann', 'Ann Lee']);
});

test('markdown splits mentions out of the text, not out of links', () => {
  const runs = parseMarkdown(`hi <@${bob.id}> see https://a.co/x`)[0].runs;
  expect(runs.map(r => [r.value, r.mention, r.url])).toEqual([
    ['hi ', undefined, undefined],
    [`<@${bob.id}>`, bob.id, undefined],
    [' see ', undefined, undefined],
    ['https://a.co/x', undefined, 'https://a.co/x'],
  ]);
});
