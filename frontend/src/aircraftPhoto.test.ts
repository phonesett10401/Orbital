/**
 * The photo lookup, tested against recorded payloads.
 *
 * The shapes below are real responses, copied from live calls: the Ryanair
 * 737 that has a photograph, and the empty answer the API gives for four
 * aircraft in every twenty.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CACHE_TTL_MS,
  cachedPhoto,
  clearPhotoCache,
  fetchAircraftPhoto,
  isRetryable,
  parsePhotos,
  photoUrlFor,
} from './aircraftPhoto';

/** A real response, for hex 4ca853 - EI-EMK, a Ryanair 737-8AS. */
const WITH_PHOTO = {
  photos: [
    {
      id: '1930991',
      thumbnail: {
        src: 'https://t.plnspttrs.net/10875/1930991_5023680b6c_t.jpg',
        size: { width: 200, height: 112 },
      },
      thumbnail_large: {
        src: 'https://t.plnspttrs.net/10875/1930991_5023680b6c_280.jpg',
        size: { width: 497, height: 280 },
      },
      link: 'https://www.planespotters.net/photo/1930991/ei-emk-ryanair-boeing-737-8as-wl',
      photographer: 'Rafal Pruszkowski',
    },
  ],
};

/** The real answer for an airframe the archive has never seen. */
const NO_PHOTO = { photos: [] };

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => clearPhotoCache());

describe('reading the response', () => {
  it('takes the large thumbnail, because the panel is wider than 200px', () => {
    const photo = parsePhotos(WITH_PHOTO)!;
    expect(photo.src).toContain('_280.jpg');
    expect(photo.width).toBe(497);
    expect(photo.photographer).toBe('Rafal Pruszkowski');
  });

  it('uses the returned URLs unchanged, which the terms require', () => {
    // "All URLs returned by the API must be used unchanged. Proxying,
    // rewriting, or hot-link-protection bypassing is not permitted." A test
    // rather than a comment, because a well-meaning CDN rewrite would look
    // like an optimisation.
    const photo = parsePhotos(WITH_PHOTO)!;
    expect(photo.src).toBe(WITH_PHOTO.photos[0].thumbnail_large.src);
    expect(photo.link).toBe(WITH_PHOTO.photos[0].link);
  });

  it('falls back to the small thumbnail rather than assuming both exist', () => {
    const onlySmall = { photos: [{ ...WITH_PHOTO.photos[0], thumbnail_large: undefined }] };
    expect(parsePhotos(onlySmall)!.src).toContain('_t.jpg');
  });

  it('reports no photograph rather than throwing, for one aircraft in five', () => {
    // 81% of real aircraft over southern England had one. The other 19% is an
    // answer, not a failure, and the panel draws it differently (D116).
    expect(parsePhotos(NO_PHOTO)).toBeNull();
  });

  it('refuses a photo it could not attribute', () => {
    // Credit and link-back are conditions of showing the image at all, so a
    // record missing either is treated as no record rather than shown bare.
    for (const missing of ['link', 'photographer'] as const) {
      const partial = { photos: [{ ...WITH_PHOTO.photos[0], [missing]: undefined }] };
      expect(parsePhotos(partial)).toBeNull();
    }
  });

  it('survives a payload that is not the shape we expect', () => {
    for (const junk of [null, undefined, {}, { photos: null }, { photos: [null] }, 42]) {
      expect(parsePhotos(junk)).toBeNull();
    }
  });
});

describe('the request', () => {
  it('keys on the hex, lowercased', () => {
    expect(photoUrlFor('4CA853')).toBe(
      'https://api.planespotters.net/pub/photos/hex/4ca853',
    );
  });

  it('retries a server error once, and not a client error', async () => {
    // Measured: one request in sixty returned HTTP 525, a Cloudflare origin
    // hiccup, and the same hex returned a photograph a second later. A 4xx
    // means the answer is no.
    expect(isRetryable(525)).toBe(true);
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(404)).toBe(false);

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(null, 525))
      .mockResolvedValueOnce(response(WITH_PHOTO));
    const photo = await fetchAircraftPhoto('4ca853', { fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(photo!.photographer).toBe('Rafal Pruszkowski');
  });

  it('gives up on a client error without asking twice', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(null, 403));
    await expect(
      fetchAircraftPhoto('4ca853', { fetchImpl: fetchImpl as never }),
    ).rejects.toThrow('403');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('caching, within what the terms allow', () => {
  it('asks once per airframe', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(WITH_PHOTO));
    await fetchAircraftPhoto('4ca853', { fetchImpl: fetchImpl as never });
    await fetchAircraftPhoto('4CA853', { fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('remembers that there was no photograph, so an absence costs one request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(NO_PHOTO));
    expect(await fetchAircraftPhoto('ffffff', { fetchImpl: fetchImpl as never })).toBeNull();
    expect(await fetchAircraftPhoto('ffffff', { fetchImpl: fetchImpl as never })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('holds nothing longer than the 24 hours the terms permit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(WITH_PHOTO));
    const t0 = 1_000_000;
    await fetchAircraftPhoto('4ca853', { fetchImpl: fetchImpl as never, now: t0 });

    expect(cachedPhoto('4ca853', t0 + CACHE_TTL_MS - 1)).toBeDefined();
    expect(cachedPhoto('4ca853', t0 + CACHE_TTL_MS + 1)).toBeUndefined();

    await fetchAircraftPhoto('4ca853', {
      fetchImpl: fetchImpl as never,
      now: t0 + CACHE_TTL_MS + 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches metadata only — never the image', () => {
    // "Image binaries must be fetched straight from the thumbnail URLs by the
    // same browser that displays them... what is not permitted is writing it
    // to storage." The cache holds a URL and a name; the browser fetches the
    // picture. This asserts the cached value carries no binary.
    const photo = parsePhotos(WITH_PHOTO)!;
    for (const value of Object.values(photo)) {
      expect(typeof value === 'string' || typeof value === 'number').toBe(true);
    }
    expect(photo.src.startsWith('https://')).toBe(true);
  });
});
