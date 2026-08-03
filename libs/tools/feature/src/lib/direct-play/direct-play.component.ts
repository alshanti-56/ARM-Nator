import { ClipboardModule } from '@angular/cdk/clipboard';
import { DatePipe, DecimalPipe, JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { DirectPlayController } from './direct-play.controller';

@Component({
    selector: 'app-direct-play',
    imports: [
        ClipboardModule,
        DatePipe,
        DecimalPipe,
        FormsModule,
        JsonPipe,
        MatButtonModule,
        MatCheckboxModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MatSelectModule,
    ],
    templateUrl: './direct-play.component.html',
    styleUrl: './direct-play.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DirectPlayComponent extends DirectPlayController {}
