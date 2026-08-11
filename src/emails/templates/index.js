function notificationEmail({ recipientName, message, actionUrl }) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <h2 style="font-weight: 500;">Hi ${recipientName},</h2>
      <p>${message}</p>
      ${actionUrl ? `<p><a href="${actionUrl}" style="color:#024ad8;">Open BIWORKSPACE</a></p>` : ''}
      <hr style="border:none;border-top:1px solid #e8e8e8;margin:24px 0;" />
      <p style="color:#636363;font-size:12px;">You're receiving this because you have notifications enabled.</p>
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

function inviteEmail({ recipientName, inviterName, temporaryPassword, loginUrl, acceptUrl, emailTo }) {
  const primaryUrl = acceptUrl || loginUrl;
  const safeName = recipientName || 'there';
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; background:#f4f6fb; padding:24px 12px;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
        <div style="background:#024ad8;color:#fff;padding:20px 24px;">
          <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.9;">Invitation from</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px;">BIWORKSPACE</div>
        </div>
        <div style="padding:28px 24px;">
          <h2 style="font-weight:600;margin:0 0 12px;font-size:20px;">You're invited to BIWORKSPACE</h2>
          <p style="margin:0 0 12px;line-height:1.5;">
            Hi <strong>${safeName}</strong>,
          </p>
          <p style="margin:0 0 16px;line-height:1.5;">
            <strong>${inviterName}</strong> invited you to join <strong>BIWORKSPACE</strong>.
            This email was sent to <strong>${emailTo || 'your inbox'}</strong> from BIWORKSPACE.
          </p>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 8px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Your login details</p>
            <p style="margin:0 0 6px;"><strong>Email:</strong> ${emailTo || '—'}</p>
            <p style="margin:0;"><strong>Temporary password:</strong>
              <code style="background:#fff;border:1px solid #e2e8f0;padding:2px 8px;border-radius:4px;">${temporaryPassword}</code>
            </p>
          </div>
          <p style="margin:24px 0;">
            <a href="${primaryUrl}" style="display:inline-block;background:#024ad8;color:#fff;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:700;font-size:14px;">
              ${acceptUrl ? 'Accept invite &amp; set password' : 'Sign in to BIWORKSPACE'}
            </a>
          </p>
          ${acceptUrl && loginUrl ? `<p style="font-size:13px;color:#64748b;">Or <a href="${loginUrl}" style="color:#024ad8;">sign in directly</a>.</p>` : ''}
          <p style="color:#94a3b8;font-size:12px;margin-top:24px;line-height:1.5;">
            This invite expires in 7 days. If you did not expect this email, you can ignore it.
          </p>
        </div>
        <div style="background:#f8fafc;padding:14px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#64748b;">
          Sent by <strong>BIWORKSPACE</strong> · Do not reply to this message
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
