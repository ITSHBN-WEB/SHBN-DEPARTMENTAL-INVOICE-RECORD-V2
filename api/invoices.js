const { Pool } = require('@neondatabase/serverless');

// Explicit column list (rather than SELECT *) so we can force
// date_received to a plain "YYYY-MM-DD" string via to_char(). Without
// this, the driver can hand back a Date object for plain DATE columns
// that shifts by a day depending on timezone — to_char sidesteps that
// entirely by never letting it become a Date object in the first place.
const SELECT_COLUMNS = `
  id, supplier, main_department, sub_department, inv_odo_no, po_no,
  to_char(date_received, 'YYYY-MM-DD') AS date_received,
  total_carton, total_amount, record_by, key_in_by, date_key_in,
  status, created_at, completed_at
`;

function rowToObject(r) {
  return {
    id: r.id,
    supplier: r.supplier,
    main_department: r.main_department,
    sub_department: r.sub_department,
    inv_odo_no: r.inv_odo_no,
    po_no: r.po_no,
    date_received: r.date_received,
    total_carton: r.total_carton,
    total_amount: r.total_amount,
    record_by: r.record_by,
    key_in_by: r.key_in_by,
    date_key_in: r.date_key_in ? new Date(r.date_key_in).toISOString() : '',
    status: r.status,
    created_at: new Date(r.created_at).toISOString(),
    completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : ''
  };
}

async function newEntry(pool, body) {
  if (!body.date_received) {
    return { success: false, error: 'Date of Received is required.' };
  }
  const { rows } = await pool.query(
    `INSERT INTO invoices
       (supplier, main_department, sub_department, inv_odo_no, po_no,
        date_received, total_carton, total_amount, record_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      body.supplier || '',
      body.main_department || '',
      body.sub_department || '',
      body.inv_odo_no || '',
      body.po_no || '',
      body.date_received,
      (body.total_carton === '' || body.total_carton == null) ? null : Number(body.total_carton),
      (body.total_amount === '' || body.total_amount == null) ? null : Number(body.total_amount),
      body.record_by || ''
    ]
  );
  return { success: true, id: rows[0].id };
}

async function listPending(pool) {
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM invoices WHERE status = 'PENDING' ORDER BY created_at DESC`
  );
  return { success: true, data: rows.map(rowToObject) };
}

async function listCompleted(pool, monthsBack) {
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM invoices
     WHERE status = 'COMPLETED'
       AND completed_at >= now() - make_interval(months => $1)
     ORDER BY completed_at DESC`,
    [monthsBack || 4]
  );
  return { success: true, data: rows.map(rowToObject) };
}

// Used for both the Admin Printable Report (mainDept/subDept omitted)
// and the Invoice Summary tab (both supplied).
async function listReport(pool, startDate, endDate, mainDept, subDept) {
  if (!startDate || !endDate) {
    return { success: false, error: 'Both a start and end date are required.' };
  }
  const conditions = [`created_at >= $1::date`, `created_at < ($2::date + interval '1 day')`];
  const params = [startDate, endDate];
  if (mainDept) { params.push(mainDept); conditions.push(`main_department = $${params.length}`); }
  if (subDept)  { params.push(subDept);  conditions.push(`sub_department = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM invoices WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
    params
  );
  return { success: true, data: rows.map(rowToObject) };
}

async function updateEntry(pool, body) {
  if (!body.date_received) {
    return { success: false, error: 'Date of Received is required.' };
  }
  const { rowCount } = await pool.query(
    `UPDATE invoices SET
       supplier = $1, main_department = $2, sub_department = $3,
       inv_odo_no = $4, po_no = $5, date_received = $6,
       total_carton = $7, total_amount = $8, record_by = $9
     WHERE id = $10`,
    [
      body.supplier || '',
      body.main_department || '',
      body.sub_department || '',
      body.inv_odo_no || '',
      body.po_no || '',
      body.date_received,
      (body.total_carton === '' || body.total_carton == null) ? null : Number(body.total_carton),
      (body.total_amount === '' || body.total_amount == null) ? null : Number(body.total_amount),
      body.record_by || '',
      body.id
    ]
  );
  if (rowCount === 0) return { success: false, error: 'Record not found' };
  return { success: true };
}

async function completeEntry(pool, body) {
  if (!body.key_in_by) {
    return { success: false, error: 'Key In By is required.' };
  }
  const { rowCount } = await pool.query(
    `UPDATE invoices SET
       key_in_by = $1, date_key_in = now(), status = 'COMPLETED', completed_at = now()
     WHERE id = $2`,
    [body.key_in_by, body.id]
  );
  if (rowCount === 0) return { success: false, error: 'Record not found' };
  return { success: true };
}

async function deleteEntry(pool, body) {
  const { rowCount } = await pool.query(`DELETE FROM invoices WHERE id = $1`, [body.id]);
  if (rowCount === 0) return { success: false, error: 'Record not found' };
  return { success: true };
}

module.exports = async (req, res) => {
  // Allows index.html on GitHub Pages (a different origin) to call this.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const { action, ...body } = req.body || {};
    let result;
    switch (action) {
      case 'newEntry':       result = await newEntry(pool, body); break;
      case 'listPending':    result = await listPending(pool); break;
      case 'listCompleted':  result = await listCompleted(pool, body.monthsBack); break;
      case 'listReport':     result = await listReport(pool, body.startDate, body.endDate); break;
      case 'listSummary':    result = await listReport(pool, body.startDate, body.endDate, body.mainDepartment, body.subDepartment); break;
      case 'updateEntry':    result = await updateEntry(pool, body); break;
      case 'completeEntry':  result = await completeEntry(pool, body); break;
      case 'deleteEntry':    result = await deleteEntry(pool, body); break;
      default: result = { success: false, error: 'Unknown action: ' + action };
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(200).json({ success: false, error: err.message });
  } finally {
    await pool.end();
  }
};
