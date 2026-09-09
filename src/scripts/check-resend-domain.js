require('dotenv').config();

async function main() {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    console.log('NO_RESEND_API_KEY — set RESEND_API_KEY in backend/.env');
    process.exit(1);
  }

  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log('Resend domains error:', res.status, body);
    process.exit(1);
  }

  const domains = body.data || [];
  console.log('Resend domains:', domains.length || 0);
  for (const d of domains) {
    console.log('\n—', d.name, '| status:', d.status, '| region:', d.region || '—');
    for (const r of d.records || []) {
      console.log(
        `  ${r.record || r.type}  name=${r.name}  status=${r.status}  value=${String(r.value || '').slice(0, 90)}`
      );
    }
  }

  const primary = domains.find((d) => String(d.name).toLowerCase() === 'bicomworkspace.com');
  if (!primary) {
    console.log('\nACTION: Add domain bicomworkspace.com at https://resend.com/domains');
  } else if (String(primary.status).toLowerCase() !== 'verified') {
    console.log('\nACTION: bicomworkspace.com exists but is NOT verified. Fix DNS records above, then click Verify in Resend.');
  } else {
    console.log('\nOK: bicomworkspace.com is verified — invites can go directly to any recipient.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
