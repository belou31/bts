// src/services/mailer.js
import { sendMail as _sendMail } from '../loaders/mailer.js';
export const sendMail = _sendMail;
export default { sendMail };
