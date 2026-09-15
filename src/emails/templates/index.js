function notificationEmail({ recipientName, message, actionUrl, actionLabel }) {
  const cta = actionLabel || 'Open in BIWORKSPACE';
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <p style="font-size:12px;color:#636363;margin:0 0 16px;">BIWORKSPACE</p>
      <h2 style="font-weight: 500;">Hi ${recipientName || 'there'},</h2>
      <p style="line-height:1.5;font-size:15px;">${message}</p>
      ${actionUrl ? `<p style="margin:24px 0;"><a href="${actionUrl}" style="display:inline-block;background:#024ad8;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px;font-weight:600;">${cta}</a></p>` : ''}
      ${actionUrl ? `<p style="font-size:12px;color:#636363;word-break:break-all;">Or open this link:<br/><a href="${actionUrl}" style="color:#024ad8;">${actionUrl}</a></p>` : ''}
      <hr style="border:none;border-top:1px solid #e8e8e8;margin:24px 0;" />
      <p style="color:#636363;font-size:12px;">You're receiving this because you were assigned work in BIWORKSPACE.</p>
    </div>
  `;
}

function welcomeEmail({ name }) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <h2 style="font-weight: 500;">Welcome, ${name}</h2>
      <p>Your BIWORKSPACE account has been created. Sign in to start collaborating with your team.</p>
    </div>
  `;
}

/**
 * @param {object} opts
 * @param {'password'|'google'} [opts.inviteMode] - password = company webmail; google = default
 * @param {string|number} [opts.expiresInMinutes]
 * @param {string} [opts.roleLabel]
 */
function inviteEmail({
  recipientName,
  inviterName,
  loginUrl,
  acceptUrl,
  emailTo,
  inviteMode = 'google',
  expiresInMinutes = 24 * 60,
  roleLabel,
}) {
  const primaryUrl = acceptUrl || loginUrl;
  const safeName = recipientName || 'there';
  const isPassword = inviteMode === 'password';
  const expiryLabel =
    Number(expiresInMinutes) >= 1440
      ? `${Math.round(Number(expiresInMinutes) / 1440)} day${
          Math.round(Number(expiresInMinutes) / 1440) === 1 ? '' : 's'
        }`
      : Number(expiresInMinutes) >= 60
        ? `${Math.round(Number(expiresInMinutes) / 60)} hour${
            Math.round(Number(expiresInMinutes) / 60) === 1 ? '' : 's'
          }`
        : `${expiresInMinutes} minute${Number(expiresInMinutes) === 1 ? '' : 's'}`;

  const howTo = isPassword
    ? `
            <p style="margin:0 0 6px;"><strong>1.</strong> Open the invitation link below</p>
            <p style="margin:0 0 6px;"><strong>2.</strong> Create a password for your account</p>
            <p style="margin:0;"><strong>3.</strong> Sign in with <strong>${emailTo || 'your company email'}</strong> and that password</p>
          `
    : `
            <p style="margin:0 0 6px;"><strong>1.</strong> Open the invitation link below</p>
            <p style="margin:0 0 6px;"><strong>2.</strong> Continue with Google</p>
            <p style="margin:0;"><strong>3.</strong> Use this Google account: <strong>${emailTo || '—'}</strong></p>
          `;

  const ctaLabel = isPassword
    ? 'Accept invitation'
    : acceptUrl
      ? 'Accept invitation'
      : 'Open BIWORKSPACE';

  const footerNote = isPassword
    ? `This invitation expires in <strong>${expiryLabel}</strong>. Your email and role are set by your admin. After accepting, sign in with your email and password.`
    : `This invitation expires in <strong>${expiryLabel}</strong>. Sign in with Google using the invited email address.`;

  const midNote = isPassword
    ? `<p style="font-size:13px;color:#64748b;line-height:1.5;">Email${
        roleLabel ? ` and role (<strong>${roleLabel}</strong>)` : ''
      } are pre-filled and cannot be changed. Only create your password on the next screen.</p>`
    : acceptUrl && loginUrl
      ? `<p style="font-size:13px;color:#64748b;line-height:1.5;">Use the button above and continue with Google. Password sign-in is not used for this invitation.</p>`
      : '';

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; background:#f8fafc; padding:24px 12px;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
        <div style="background:#0f172a;color:#fff;padding:18px 24px;">
          <div style="font-size:12px;letter-spacing:0.04em;opacity:0.85;">BIWORKSPACE</div>
          <div style="font-size:18px;font-weight:600;margin-top:4px;">Workspace invitation</div>
        </div>
        <div style="padding:28px 24px;">
          <p style="margin:0 0 12px;line-height:1.5;">
            Hi <strong>${safeName}</strong>,
          </p>
          <p style="margin:0 0 16px;line-height:1.5;">
            <strong>${inviterName}</strong> invited you to the <strong>BIWORKSPACE</strong> workspace${
              roleLabel ? ` as <strong>${roleLabel}</strong>` : ''
            }.
            This message was sent to <strong>${emailTo || 'your inbox'}</strong>.
          </p>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 8px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Next steps</p>
            ${howTo}
          </div>
          <p style="margin:24px 0;">
            <a href="${primaryUrl}" style="display:inline-block;background:#024ad8;color:#fff;padding:12px 22px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
              ${ctaLabel}
            </a>
          </p>
          <p style="font-size:12px;color:#64748b;line-height:1.5;word-break:break-all;">
            Or paste this link into your browser:<br/>
            <a href="${primaryUrl}" style="color:#024ad8;">${primaryUrl}</a>
          </p>
          ${midNote}
          <p style="color:#94a3b8;font-size:12px;margin-top:24px;line-height:1.5;">
            ${footerNote}
          </p>
          <p style="color:#94a3b8;font-size:12px;margin-top:12px;line-height:1.5;">
            If you did not expect this invitation, you can ignore this email.
          </p>
        </div>
        <div style="background:#f8fafc;padding:14px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#64748b;">
          Sent by BIWORKSPACE · Transactional account invitation
        </div>
      </div>
    </div>
  `;
}

function passwordResetEmail({ recipientName, otp, resetUrl }) {
  const safeName = recipientName || 'there';
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; background:#f4f6fb; padding:24px 12px;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
        <div style="background:#024ad8;color:#fff;padding:20px 24px;">
          <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.9;">Security · BIWORKSPACE</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px;">Password reset code</div>
        </div>
        <div style="padding:28px 24px;">
          <p style="margin:0 0 12px;line-height:1.5;">Hi <strong>${safeName}</strong>,</p>
          <p style="margin:0 0 16px;line-height:1.5;">
            Use this one-time code to reset your <strong>BIWORKSPACE</strong> password.
            This email was sent from BIWORKSPACE.
          </p>
          <div style="background:#f8fafc;border:1px dashed #024ad8;border-radius:8px;padding:20px;text-align:center;margin:20px 0;">
            <div style="font-size:12px;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;">Your OTP code</div>
            <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#024ad8;">${otp}</div>
          </div>
          <p style="color:#64748b;font-size:13px;line-height:1.5;">
            This code expires in <strong>10 minutes</strong>. Enter it on the reset password screen, then choose a new password and sign in.
          </p>
          ${
            resetUrl
              ? `<p style="margin:20px 0 0;font-size:13px;color:#64748b;">Or open: <a href="${resetUrl}" style="color:#024ad8;">${resetUrl}</a></p>`
              : ''
          }
          <p style="color:#94a3b8;font-size:12px;margin-top:24px;">If you did not request this, you can ignore this email.</p>
        </div>
        <div style="background:#f8fafc;padding:14px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#64748b;">
          Sent by <strong>BIWORKSPACE</strong>
        </div>
      </div>
    </div>
  `;
}

module.exports = { notificationEmail, welcomeEmail, inviteEmail, passwordResetEmail };
