import { Mailable } from '@tylix/mail';

// "New enquiry / viewing request / application" for the office inbox.
export class StaffNoticeMail extends Mailable {
    constructor(private notice: { subject: string; heading: string; lines: string[]; url: string }) {
        super();
    }

    build() {
        return {
            subject: this.notice.subject,
            view: 'staff-notice',
            data: {
                heading: this.notice.heading,
                body: this.notice.lines.join('\n'),
                url: this.notice.url,
            },
        };
    }
}
