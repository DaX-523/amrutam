/** Prints the current TOTP code for the demo secret (or a secret passed as argv[2]). */
import { generate } from 'otplib';

const secret = process.argv[2] ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
console.log(await generate({ secret }));
