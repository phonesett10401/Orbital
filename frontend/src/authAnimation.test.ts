import { describe, expect, it } from 'vitest';

import {
  MOTION,
  STILL,
  acceptsInput,
  phaseClass,
  submitLabel,
  successMessage,
  timings,
} from './authAnimation';

describe('timings', () => {
  it('moves by default', () => {
    expect(timings(false)).toBe(MOTION);
    expect(MOTION.panelIn).toBeGreaterThan(0);
  });

  it('takes every animation to zero when the reader asked it to', () => {
    // Zero, not merely smaller. An interface that keeps a little of the motion
    // has misunderstood what `prefers-reduced-motion` asks for.
    const still = timings(true);
    expect(still.panelIn).toBe(0);
    expect(still.modeSwap).toBe(0);
    expect(still.shake).toBe(0);
  });

  it('still holds the success message when nothing else moves', () => {
    // The one duration carrying information rather than decoration. A
    // confirmation nobody has time to read is not a kindness.
    expect(STILL.successHold).toBeGreaterThan(0);
  });

  it('confirms without celebrating', () => {
    // Long enough to be read, short enough not to be a wait. The account is
    // already signed in by this point; the delay is entirely for the person.
    expect(MOTION.successHold).toBeGreaterThanOrEqual(600);
    expect(MOTION.successHold).toBeLessThanOrEqual(1200);
  });

  it('opens quickly enough to feel like a response to the click', () => {
    // Past about 300ms an opening panel stops reading as caused by the click.
    expect(MOTION.panelIn).toBeLessThanOrEqual(300);
  });
});

describe('phases', () => {
  it('gives the panel nothing to wear when nothing is happening', () => {
    expect(phaseClass('idle')).toBe('');
  });

  it('names each of the others distinctly', () => {
    const named = ['working', 'success', 'error'] as const;
    const classes = named.map(phaseClass);
    expect(new Set(classes).size).toBe(named.length);
    for (const c of classes) expect(c).toContain('account__panel--');
  });

  it('takes input while idle, and after a refusal', () => {
    // A form left disabled after a failure is how a sign-in becomes
    // unrecoverable without a page reload (D148).
    expect(acceptsInput('idle')).toBe(true);
    expect(acceptsInput('error')).toBe(true);
  });

  it('refuses input while working or already done', () => {
    // A second submission during the closing animation would race the close.
    expect(acceptsInput('working')).toBe(false);
    expect(acceptsInput('success')).toBe(false);
  });
});

describe('what it says', () => {
  it('does not tell somebody new that they are back', () => {
    expect(successMessage('register')).not.toMatch(/back/i);
    expect(successMessage('signin')).toMatch(/back/i);
  });

  it('says what is happening rather than going blank', () => {
    // A button that empties looks broken; one that says so looks busy.
    expect(submitLabel('working', 'signin')).toBeTruthy();
    expect(submitLabel('working', 'signin')).not.toBe(submitLabel('idle', 'signin'));
  });

  it('labels the button for the action it will actually take', () => {
    // The bug in D148 was the panel reopening in register mode, so the label
    // and the endpoint disagreeing is a fault this project has already had.
    expect(submitLabel('idle', 'register')).toMatch(/create/i);
    expect(submitLabel('idle', 'signin')).toMatch(/sign in/i);
  });
});
