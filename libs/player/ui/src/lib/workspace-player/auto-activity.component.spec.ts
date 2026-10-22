import { ComponentFixture, TestBed } from '@angular/core/testing';
import { VideoPlayer } from '@arm-nator/shared/interfaces';
import type { AutomaticPlaybackActivity } from '@arm-nator/player/core';
import { AutoActivityComponent } from './auto-activity.component';

describe('AutoActivityComponent', () => {
  let fixture: ComponentFixture<AutoActivityComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AutoActivityComponent],
    }).compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
    TestBed.resetTestingModule();
  });

  it('keeps started playback distinct from 30-second verification in collapsible attempt history', async () => {
    const activity: AutomaticPlaybackActivity = {
      status: 'recovering',
      attempts: [
        {
          number: 1,
          host: 'https://viewer:secret@media.example.test/live/channel.m3u8?token=private',
          format: 'hls',
          engine: VideoPlayer.Html5Player,
          outcome: 'playing',
          verified: false,
          reason:
            'Playback started from https://viewer:secret@media.example.test/live/channel.m3u8?token=private. Source=/internal/channel.m3u8?token=private. Local path C:\\private\\channel.m3u8?token=private. Authorization: Bearer bearer-secret.',
        },
        {
          number: 2,
          host: 'fallback.example.test',
          format: 'unknown',
          engine: null,
          outcome: 'failed',
          verified: true,
          reason: 'The stream stalled after it had been verified.',
        },
      ],
    };

    fixture = TestBed.createComponent(AutoActivityComponent);
    fixture.componentRef.setInput('activity', activity);
    fixture.autoDetectChanges();
    await fixture.whenStable();

    const details = fixture.nativeElement.querySelector('details') as HTMLDetailsElement;
    const summary = fixture.nativeElement.querySelector('summary') as HTMLElement;

    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(summary.textContent).toContain('Auto activity');

    summary.click();
    await fixture.whenStable();

    const rendered = details.textContent ?? '';
    expect(details.open).toBe(true);
    expect(rendered).toContain('Playback started');
    expect(rendered).toContain('Verification pending');
    expect(rendered).toContain('30 sec verified earlier');
    expect(rendered).toContain('Failed');
    expect(rendered).toContain('Unknown format');
    expect(rendered).toContain('Unknown player');
    expect(rendered).toContain('media.example.test');
    expect(rendered).not.toContain('viewer');
    expect(rendered).not.toContain('secret');
    expect(rendered).not.toContain('channel.m3u8');
    expect(rendered).not.toContain('token=private');
    expect(rendered).not.toContain('/internal');
    expect(rendered).not.toContain('C:\\private');
    expect(rendered).not.toContain('bearer-secret');
  });

  it('shows the final stop reason while hiding an idle activity section', async () => {
    const activity: AutomaticPlaybackActivity = {
      status: 'stopped',
      attempts: [
        {
          number: 1,
          host: 'stream.example.test',
          format: 'progressive',
          engine: VideoPlayer.ArtPlayer2,
          outcome: 'failed',
          verified: false,
          reason: 'The source ended before playback started.',
        },
      ],
      stopReason: 'Stopped after /streams/channel?token=private was rejected.',
    };

    fixture = TestBed.createComponent(AutoActivityComponent);
    fixture.componentRef.setInput('activity', activity);
    fixture.autoDetectChanges();
    await fixture.whenStable();

    const details = fixture.nativeElement.querySelector('details') as HTMLDetailsElement;
    details.querySelector('summary')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await fixture.whenStable();

    const rendered = fixture.nativeElement.textContent ?? '';
    expect(details.open).toBe(true);
    expect(rendered).toContain('Final stop reason');
    expect(rendered).toContain('Stopped after');
    expect(rendered).not.toContain('/streams/channel');
    expect(rendered).not.toContain('token=private');

    fixture.componentRef.setInput('activity', { status: 'idle', attempts: [] });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('details')).toBeNull();
  });
});
