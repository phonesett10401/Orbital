/**
 * The photograph at the top of an aircraft's detail panel.
 *
 * The attribution is not decoration around the image, it is a **condition of
 * using it** (see `aircraftPhoto.ts`), so it is built into the same element
 * rather than left to a sibling that a later layout change could drop: the
 * anchor *is* the thumbnail, and the credit sits inside the figure with it.
 *
 * One aircraft in five has no photograph. That branch renders a deliberate
 * line rather than nothing, because a panel that silently loses its top third
 * reads as broken - and because the absence is a fact about the photo archive,
 * not about the aircraft, which is a distinction worth stating (D116).
 */

import { useEffect, useState } from 'react';

import { fetchAircraftPhoto, type PhotoState } from '../aircraftPhoto';

export function AircraftPhoto({ icao24 }: { icao24: string }) {
  const [state, setState] = useState<PhotoState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });

    fetchAircraftPhoto(icao24, { signal: controller.signal })
      .then((photo) => {
        if (controller.signal.aborted) return;
        setState(photo ? { status: 'ready', photo } : { status: 'absent' });
      })
      .catch((error: unknown) => {
        if ((error as Error).name === 'AbortError') return;
        // Distinct from `absent`: one means the archive has no photograph of
        // this airframe, the other means we could not ask. Collapsing them
        // would report a network fault as a fact about the aircraft.
        setState({ status: 'error' });
      });

    return () => controller.abort();
  }, [icao24]);

  if (state.status === 'loading') {
    return <div className="panel__photo panel__photo--pending" aria-hidden="true" />;
  }

  if (state.status === 'absent') {
    return (
      <div className="panel__photo panel__photo--none">
        No photograph of this airframe
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="panel__photo panel__photo--none">
        Could not reach the photo archive
      </div>
    );
  }

  const { photo } = state;
  return (
    <figure className="panel__photo">
      {/*
        A plain anchor, deliberately: the terms require the thumbnail to lead
        back to the photo's page, and forbid `rel="nofollow"`. `noopener` is
        kept because it is a security property rather than a link-equity one.
      */}
      <a href={photo.link} target="_blank" rel="noopener">
        <img
          src={photo.src}
          width={photo.width || undefined}
          height={photo.height || undefined}
          alt=""
          loading="lazy"
        />
      </a>
      <figcaption>
        <span className="panel__photo-credit">© {photo.photographer}</span>
        <a href={photo.link} target="_blank" rel="noopener">
          Planespotters
        </a>
      </figcaption>
    </figure>
  );
}
