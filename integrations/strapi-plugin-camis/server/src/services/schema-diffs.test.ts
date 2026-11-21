import { describe, expect, it } from 'vitest';
import { describeDiff, isBenign, type Diff } from './schema-diffs';

describe('schema diffs on pull', () => {
  it('lets an empty options or pluginOptions one side writes and the other omits pass', () => {
    const empty: Diff = { kind: 'deleted', path: ['pluginOptions'], type: 'object', value: {} };
    expect(isBenign('api::article.article', empty)).toBe(true);
    expect(isBenign('shared.seo', { kind: 'added', path: ['options'], type: 'object', value: {} })).toBe(true);
  });

  it("lets the Enterprise plugins CAMIS does not build pass, as Strapi's own import lets review workflows", () => {
    for (const uid of ['plugin::content-releases.release', 'plugin::review-workflows.workflow-stage']) {
      expect(isBenign(uid, { kind: 'added', path: [], type: 'object', value: {} })).toBe(true);
    }
  });

  it('stops on a real difference', () => {
    expect(
      isBenign('api::article.article', {
        kind: 'deleted',
        path: ['options'],
        type: 'object',
        value: { draftAndPublish: true },
      }),
    ).toBe(false);
    expect(
      isBenign('api::article.article', { kind: 'added', path: ['attributes', 'subtitle'], type: 'object', value: {} }),
    ).toBe(false);
    expect(isBenign('api::page.page', { kind: 'deleted', path: [], type: 'object', value: {} })).toBe(false);
    expect(
      isBenign('api::article.article', {
        kind: 'modified',
        path: ['attributes', 'title', 'type'],
        types: ['string', 'string'],
        values: ['string', 'text'],
      }),
    ).toBe(false);
  });

  it('words a difference as strapi import does', () => {
    expect(describeDiff('api::page.page', { kind: 'deleted', path: [], type: 'object', value: {} })).toBe(
      'api::page.page does not exist on destination',
    );
    expect(describeDiff('api::a.a', { kind: 'added', path: ['attributes', 'x'], type: 'object', value: {} })).toBe(
      'api::a.a.attributes.x does not exist on source',
    );
  });
});
