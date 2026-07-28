import { bootstrapApplication } from '@angular/platform-browser';
import { registerAppDateLocales } from './app/app-date-locales';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

registerAppDateLocales();

bootstrapApplication(AppComponent, appConfig)
    .then(() => {
        // Splash is rendered eagerly by index.html so the user sees something
        // immediately instead of a blank Material-grey background. Once Angular
        // is bootstrapped, AppComponent has rendered and we can drop the
        // splash. requestAnimationFrame ensures the swap happens after the
        // first AppComponent paint, avoiding a flash of empty background
        // between splash removal and Angular's first frame.
        requestAnimationFrame(() => {
            document.getElementById('initial-splash')?.remove();
        });
    })
    .catch((err) => console.error(err));
