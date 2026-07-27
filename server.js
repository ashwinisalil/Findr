const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { pool, initDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // higher limit — frontend sends images as base64 data URLs

const JWT_SECRET = 'change-this-to-a-long-random-string'; // move to an env variable in real use
const SALT_ROUNDS = 10;

// ===========================================================
// SHARED MIDDLEWARE — used across multiple members' routes
// ===========================================================
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization; // expects: "Bearer <token>"
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}


// ===========================================================
// MEMBER 1 — AUTH & USERS
// Matches frontend TODO(backend): POST /api/auth/register, POST /api/auth/login
// Also owns: GET /api/leaderboard (public, ranks students by points)
// ===========================================================

// Frontend: handleRegister() — creates the account, does NOT log the user in automatically
// (mock behavior: shows a toast and opens the login modal after registering)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, zprnId, password } = req.body;
    if (!name || !zprnId || !password) {
      return res.status(400).json({ error: 'name, zprnId, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const [existing] = await pool.query('SELECT id FROM users WHERE zprnId = ?', [zprnId]);
    if (existing.length > 0) return res.status(409).json({ error: 'This ZPRN ID is already registered.' });

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const [result] = await pool.query(
      'INSERT INTO users (name, zprnId, password, role, points) VALUES (?, ?, ?, ?, ?)',
      [name, zprnId, hashedPassword, 'student', 0]
    );

    res.status(201).json({ message: 'Account created! Please sign in.', userId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Frontend: handleLogin() and handleAdminLogin() both hit this same route —
// the frontend itself checks user.role !== 'admin' after a successful admin-panel login attempt.
app.post('/api/auth/login', async (req, res) => {
  try {
    const { zprnId, password } = req.body;
    if (!zprnId || !password) {
      return res.status(400).json({ error: 'zprnId and password are required' });
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE zprnId = ?', [zprnId]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid ZPRN ID or password.' });

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) return res.status(401).json({ error: 'Invalid ZPRN ID or password.' });

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, zprnId: user.zprnId, role: user.role, points: user.points }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Frontend: renderLeaderboard() — ranks students by points, highest first
app.get('/api/leaderboard', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, points FROM users WHERE role = 'student' ORDER BY points DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while fetching leaderboard' });
  }
});


// ===========================================================
// MEMBER 2 — ITEMS
// Matches frontend TODO(backend):
//   GET /api/items?status=&category=&location=&q=
//   GET /api/items/:id
//   POST /api/items  (report — FR-3)
//   PUT /api/items/:id  (edit — owner only)
//   DELETE /api/items/:id  (owner only — see also admin delete in Member 4)
//   PATCH /api/items/:id/resolve  (mark resolved without a claim — awards points if it was 'found')
//   GET /api/users/me/items
//   GET /api/categories
// ===========================================================

// Frontend: renderBoard() / homeSearch() / dashSearch() — supports status, category, location, q (search)
app.get('/api/items', async (req, res) => {
  try {
    const { status, category, location, q, includeOld } = req.query;

    let query = `
      SELECT items.*, users.name AS reportedByName
      FROM items
      JOIN users ON items.reportedBy = users.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND items.status = ?'; params.push(status);
    } else if (!includeOld) {
      // Default board view for regular visitors: hide items resolved more than
      // 3 days ago to keep the board current. Pass ?includeOld=1 (used by the
      // admin panel) to see the full history, including older resolved items.
      query += " AND (items.status != 'claimed' OR items.resolvedAt IS NULL OR items.resolvedAt > DATE_SUB(NOW(), INTERVAL 3 DAY))";
    }
    if (category) { query += ' AND items.category = ?'; params.push(category); }
    if (location) { query += ' AND items.location LIKE ?'; params.push(`%${location}%`); }
    if (q) {
      query += ' AND (items.itemName LIKE ? OR items.description LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }

    query += ' ORDER BY items.dateReported DESC';

    const [items] = await pool.query(query, params);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while fetching items' });
  }
});

// Frontend: viewDetails()
app.get('/api/items/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT items.*, users.name AS reportedByName
       FROM items JOIN users ON items.reportedBy = users.id
       WHERE items.id = ?`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Item not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while fetching item' });
  }
});

// Frontend: submitWizard() — the "new item" branch
app.post('/api/items', requireAuth, async (req, res) => {
  try {
    const { itemName, description, category, location, contactInfo, imageUrl, status, dateReported } = req.body;
    if (!itemName || !category || !description) {
      return res.status(400).json({ error: 'itemName, category, and description are required' });
    }
    if (!contactInfo || !/^\d{10}$/.test(contactInfo)) {
      return res.status(400).json({ error: 'Contact number must be exactly 10 digits' });
    }

    const [result] = await pool.query(
      `INSERT INTO items (itemName, description, category, location, contactInfo, imageUrl, status, reportedBy, dateReported)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [itemName, description, category, location || null, contactInfo || null, imageUrl || null,
       status || 'lost', req.userId, dateReported || new Date()]
    );

    res.status(201).json({ message: `"${itemName}" reported successfully!`, itemId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while reporting item' });
  }
});

// Frontend: submitWizard() — the "editingItemId" branch (Object.assign(findItem(...), data))
app.put('/api/items/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.reportedBy !== req.userId) {
      return res.status(403).json({ error: 'Only the reporter can edit this item' });
    }

    const { itemName, description, category, location, contactInfo, imageUrl, status, dateReported } = req.body;
    if (!contactInfo || !/^\d{10}$/.test(contactInfo)) {
      return res.status(400).json({ error: 'Contact number must be exactly 10 digits' });
    }
    await pool.query(
      `UPDATE items SET itemName=?, description=?, category=?, location=?, contactInfo=?, imageUrl=?, status=?, dateReported=?
       WHERE id = ?`,
      [itemName, description, category, location, contactInfo, imageUrl, status, dateReported, req.params.id]
    );

    res.json({ message: `"${itemName}" updated successfully!` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while updating item' });
  }
});

// Frontend: deleteOwnItem() — owner deletes their own item and its claims
app.delete('/api/items/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.reportedBy !== req.userId) {
      return res.status(403).json({ error: 'Only the reporter can delete this item' });
    }

    await pool.query('DELETE FROM claims WHERE itemId = ?', [req.params.id]);
    await pool.query('DELETE FROM items WHERE id = ?', [req.params.id]);

    res.json({ message: `"${item.itemName}" deleted.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while deleting item' });
  }
});

// Frontend: markResolved() — marks resolved directly, no claim needed.
// Awards +10 points if the item's status was 'found' (matches awardPoints(..., 10, "returned a found item")).
app.patch('/api/items/:id/resolve', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.reportedBy !== req.userId) {
      return res.status(403).json({ error: 'Only the reporter can mark this item resolved' });
    }

    const wasFound = item.status === 'found';
    await pool.query("UPDATE items SET status = 'claimed', resolvedAt = NOW() WHERE id = ?", [req.params.id]);

    let pointsAwarded = 0;
    if (wasFound) {
      pointsAwarded = 10;
      await pool.query('UPDATE users SET points = points + ? WHERE id = ?', [pointsAwarded, req.userId]);
    }

    res.json({ message: 'Item marked as resolved', pointsAwarded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while resolving item' });
  }
});

// Frontend: renderMyItems() — items the logged-in user reported (queried by userId, not name)
app.get('/api/users/me/items', requireAuth, async (req, res) => {
  try {
    const [items] = await pool.query(
      `SELECT items.*, users.name AS reportedByName
       FROM items JOIN users ON items.reportedBy = users.id
       WHERE items.reportedBy = ?
       ORDER BY items.dateReported DESC`,
      [req.userId]
    );
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while fetching your items' });
  }
});

// Frontend: populateSelect() — the category dropdown
app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM categories ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while fetching categories' });
  }
});


// ===========================================================
// MEMBER 3 — CLAIMS
// Matches frontend TODO(backend):
//   POST /api/items/:id/claims
//   GET /api/users/me/claims
//   GET /api/users/me/claims-received
//   PATCH /api/claims/:id
// ===========================================================

// Frontend: viewDetails() — public claim count/list for the item detail modal
app.get('/api/items/:id/claims', async (req, res) => {
  try {
    const [claims] = await pool.query(
      `SELECT claims.*, users.name AS claimantName
       FROM claims JOIN users ON claims.claimantId = users.id
       WHERE claims.itemId = ?
       ORDER BY claims.dateClaimed DESC`,
      [req.params.id]
    );
    res.json(claims);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while fetching claims for this item' });
  }
});

// Frontend: handleClaimSubmit()
app.post('/api/items/:id/claims', requireAuth, async (req, res) => {
  try {
    const itemId = req.params.id;
    const { claimMessage, contactInfo } = req.body;

    if (!contactInfo || !/^\d{10}$/.test(contactInfo)) {
      return res.status(400).json({ error: 'Contact number must be exactly 10 digits' });
    }

    const [rows] = await pool.query('SELECT * FROM items WHERE id = ?', [itemId]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.status === 'claimed') return res.status(400).json({ error: 'This item has already been claimed' });
    if (item.reportedBy === req.userId) return res.status(400).json({ error: "You can't claim your own reported item" });

    // Only one pending claim allowed on an item at a time — further claims are
    // blocked until the reporter approves or rejects the existing one.
    const [pending] = await pool.query(
      "SELECT id FROM claims WHERE itemId = ? AND status = 'pending'", [itemId]
    );
    if (pending.length > 0) {
      return res.status(409).json({ error: 'This item already has a pending claim awaiting the reporter\'s review. Please check back later.' });
    }

    const [result] = await pool.query(
      'INSERT INTO claims (itemId, claimantId, claimMessage, contactInfo) VALUES (?, ?, ?, ?)',
      [itemId, req.userId, claimMessage || null, contactInfo]
    );

    res.status(201).json({ message: 'Claim submitted! The reporter will review it.', claimId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while submitting claim' });
  }

});

// Frontend: renderMyItems() — myClaims = claims.filter(c => c.claimantId === currentUser.id)
app.get('/api/users/me/claims', requireAuth, async (req, res) => {
  try {
    const [claims] = await pool.query(
      `SELECT claims.*, items.itemName
       FROM claims JOIN items ON claims.itemId = items.id
       WHERE claims.claimantId = ?
       ORDER BY claims.dateClaimed DESC`,
      [req.userId]
    );
    res.json(claims);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while fetching your claims' });
  }
});

// Frontend: renderMyItems() — relevantClaims = claims on items the logged-in user reported
app.get('/api/users/me/claims-received', requireAuth, async (req, res) => {
  try {
    const [claims] = await pool.query(
      `SELECT claims.*, items.itemName, users.name AS claimantName
       FROM claims
       JOIN items ON claims.itemId = items.id
       JOIN users ON claims.claimantId = users.id
       WHERE items.reportedBy = ?
       ORDER BY claims.dateClaimed DESC`,
      [req.userId]
    );
    res.json(claims);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while fetching claims on your items' });
  }
});

// Frontend: approveClaim() / rejectClaim() — both call this with { status: 'approved' | 'rejected' }
// Approving: marks item 'claimed', auto-rejects other pending claims on the same item,
// and awards +15 points to the reporter if the item's status was 'found'.
app.patch('/api/claims/:id', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
    }

    const [claimRows] = await pool.query('SELECT * FROM claims WHERE id = ?', [req.params.id]);
    const claim = claimRows[0];
    if (!claim) return res.status(404).json({ error: 'Claim not found' });

    const [itemRows] = await pool.query('SELECT * FROM items WHERE id = ?', [claim.itemId]);
    const item = itemRows[0];
    if (item.reportedBy !== req.userId) {
      return res.status(403).json({ error: 'Only the reporter of this item can approve/reject claims' });
    }

    await pool.query('UPDATE claims SET status = ? WHERE id = ?', [status, req.params.id]);

    let pointsAwarded = 0;
    if (status === 'approved') {
      const wasFound = item.status === 'found';
      await pool.query("UPDATE items SET status = 'claimed', resolvedAt = NOW() WHERE id = ?", [claim.itemId]);
      // auto-reject any other still-pending claims on the same item
      await pool.query(
        "UPDATE claims SET status = 'rejected' WHERE itemId = ? AND id != ? AND status = 'pending'",
        [claim.itemId, req.params.id]
      );
      if (wasFound) {
        pointsAwarded = 15;
        await pool.query('UPDATE users SET points = points + ? WHERE id = ?', [pointsAwarded, req.userId]);
      }
    }

    res.json({ message: `Claim ${status}`, pointsAwarded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while updating claim' });
  }
});


// ===========================================================
// MEMBER 4 — ADMIN
// Matches frontend TODO(backend): GET /api/admin/stats|logs, DELETE /api/items/:id (admin context)
// ===========================================================

app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [[{ count: totalItems }]] = await pool.query('SELECT COUNT(*) AS count FROM items');
    const [[{ count: totalClaims }]] = await pool.query('SELECT COUNT(*) AS count FROM claims');
    const [[{ count: resolvedItems }]] = await pool.query("SELECT COUNT(*) AS count FROM items WHERE status = 'claimed'");
    const [[{ count: totalUsers }]] = await pool.query('SELECT COUNT(*) AS count FROM users');

    res.json({ totalItems, totalClaims, resolvedItems, totalUsers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while fetching stats' });
  }
});

app.get('/api/admin/logs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [logs] = await pool.query(
      `SELECT admin_logs.*, users.name AS adminName
       FROM admin_logs JOIN users ON admin_logs.adminId = users.id
       ORDER BY admin_logs.timestamp DESC`
    );
    res.json(logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while fetching admin logs' });
  }
});

// Frontend: adminRemoveItem() — separate route from the owner-delete in Member 2,
// since this is reachable by any admin regardless of who reported the item.
app.delete('/api/admin/items/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Item not found' });

    await pool.query('DELETE FROM claims WHERE itemId = ?', [req.params.id]);
    await pool.query('DELETE FROM items WHERE id = ?', [req.params.id]);

    await pool.query(
      'INSERT INTO admin_logs (adminId, action, itemId, itemName) VALUES (?, ?, ?, ?)',
      [req.userId, 'remove_item', item.id, item.itemName]
    );

    res.json({ message: `"${item.itemName}" removed from the platform.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while removing item' });
  }
});


// ===========================================================
// SERVER STARTUP
// ===========================================================
initDb()
  .then(() => {
    app.listen(3000, () => console.log('Server running on http://localhost:3000'));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
