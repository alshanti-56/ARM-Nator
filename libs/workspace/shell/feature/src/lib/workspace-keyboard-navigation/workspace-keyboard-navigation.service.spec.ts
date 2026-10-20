import { TestBed } from '@angular/core/testing';
import { WorkspaceKeyboardNavigationService } from './workspace-keyboard-navigation.service';

afterEach(() => {
  TestBed.resetTestingModule();
  document.body.innerHTML = '';
  jest.restoreAllMocks();
});

it('leaves arrow keys with a focused mini-player instead of navigating the library behind it', () => {
  document.body.innerHTML = '<div class="episodes-grid"><button class="episode-card">Episode</button></div><section class="workspace-player workspace-player--mini"><div class="workspace-player__identity" tabindex="0">Title</div></section>';
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100,
    toJSON: () => ({}),
  });
  TestBed.configureTestingModule({ providers: [WorkspaceKeyboardNavigationService] });
  TestBed.inject(WorkspaceKeyboardNavigationService);
  document.querySelector<HTMLButtonElement>('.episode-card')!.focus();
  const title = document.querySelector<HTMLElement>('.workspace-player__identity')!;
  title.focus();
  const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
  title.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(title);
});
