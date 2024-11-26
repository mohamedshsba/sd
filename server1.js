
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');
const requestIp = require('request-ip');
const macaddress = require('macaddress');

const app = express();
const port = 3000;

// Middleware setup
app.use(express.json());
app.use(cors());
app.use(requestIp.mw());

// Set up SQLite database
const db = new sqlite3.Database('./users.db', (err) => {
  if (err) {
    console.error('Error connecting to database:', err.message);
  } else {
    console.log('users database connected.');
  }
});

// Create tables if they don't exist
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    mac_address TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    verified_at DATETIME
  )`, (err) => {
  if (err) {
    console.error('Error creating codes table:', err.message);
  } else {
    console.log('Codes database connected.');
  }
});

// Create `code_usage` table to track which codes have been used
db.run(
  `CREATE TABLE IF NOT EXISTS code_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_page TEXT NOT NULL,
    code TEXT NOT NULL,
    used_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  (err) => {
    if (err) {
      return console.error('Error creating table:', err.message);
    }
    console.log('Table "code_usage" created successfully.');
  }
);

// Create `verified_videos` table to track which videos users have verified
db.run(`
  CREATE TABLE IF NOT EXISTS verified_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )
`, (err) => {
  if (err) {
    console.error('Error creating verified_videos table:', err.message);
  } else {
    console.log('Verified videos table created.');
  }
});

// Helper function to generate random code
function generateRandomCode() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// Register endpoint
app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const macAddress = req.clientIp; // For production, replace this with actual MAC retrieval
  if (!macAddress) {
    return res.status(400).json({ error: 'Unable to retrieve device information.' });
  }

  // Check if the email already exists
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, row) => {
    if (row) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert the new user into the database
    db.run('INSERT INTO users (email, password, mac_address) VALUES (?, ?, ?)', [email, hashedPassword, macAddress], (err) => {
      if (err) {
        console.error('Error inserting user:', err.message);
        return res.status(500).json({ error: 'Error creating user' });
      }
      res.status(201).json({ message: 'Registration successful' });
    });
  });
});

// Login endpoint
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, row) => {
    if (err) {
      console.error('Error fetching user:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (!row) {
      return res.status(400).json({ error: 'User not found.' });
    }

    const isMatch = await bcrypt.compare(password, row.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    const currentMacAddress = req.clientIp; // Replace with actual MAC retrieval
    if (email !== "admin123@gmail.com" && row.mac_address !== currentMacAddress) {
      return res.status(400).json({ error: 'This account can only be accessed from the registered device.' });
    }

    // Respond with success and user info (or token, depending on your needs)
    res.status(200).json({
      message: 'Login successful',
      email: row.email,
      userId: row.id
    });
  });
});

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint to verify code and log usage
app.post('/api/verifyCode', (req, res) => {
  const { code, videoPage } = req.body; // Include the page: 'ph' or 'chem'

  db.get('SELECT * FROM codes WHERE code = ?', [code], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to verify code' });
    }

    if (!row) {
      return res.status(400).json({ error: 'Invalid code' });
    }

    // Insert usage log into the code_usage table
    db.run(
      'INSERT INTO code_usage (video_page, code) VALUES (?, ?)',
      [videoPage, code],
      (err) => {
        if (err) {
          console.error('Error logging code usage:', err.message);
        }
      }
    );

    // Delete the code after verification
    db.run('DELETE FROM codes WHERE code = ?', [code], (err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to delete code' });
      }
      res.status(200).json({ message: 'Code verified successfully and deleted.' });
    });
  });
});

// Endpoint to fetch code usage counts
app.get('/api/getCodeUsageCounts', (req, res) => {
  db.all(
    'SELECT video_page, COUNT(*) AS usage_count FROM code_usage GROUP BY video_page',
    (err, rows) => {
      if (err) {
        console.error('Error fetching code usage counts:', err.message);
        return res.status(500).json({ error: 'Failed to fetch code usage counts' });
      }

      // Format response to return counts for 'ph' and 'chem'
      const usageCounts = { ph: 0, chem: 0 };
      rows.forEach((row) => {
        usageCounts[row.video_page] = row.usage_count;
      });

      res.json(usageCounts);
    }
  );
});
//
app.post('/api/addCode', (req, res) => {
  const code = generateRandomCode(); // Function to generate a random code

  db.run('INSERT INTO codes (code, verified_at) VALUES (?, ?)', [code, null], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Failed to add code' });
    }
    res.status(201).json({ message: 'Code added successfully', code });
  });
});
//
// API to get all codes
app.get('/api/codes', (req, res) => {
  db.all('SELECT * FROM codes', (err, rows) => {
    if (err) {
      console.error('Error fetching codes:', err);
      return res.status(500).json({ error: 'Failed to retrieve codes' });
    }
    res.json(rows);
  });
});
//

const videoPage = "ph.html";  // Or dynamically determine this based on the request
const code = "some_code";
const usageCount = 1;  // Increment this as needed

db.run('INSERT INTO code_usage (code, video_page, usage_count) VALUES (?, ?, ?)', [code, videoPage, usageCount], (err) => {
  if (err) {
    console.error('Error logging code usage:', err);
  }
});

//
// Assuming the video page is passed in the request
app.post('/api/logCodeUsage', (req, res) => {
  const { code, videoPage } = req.body;  // Ensure the body contains `code` and `videoPage`

  // Validate the input (check if code and videoPage are provided)
  if (!code || !videoPage) {
    return res.status(400).json({ error: 'Code and videoPage are required' });
  }

  // Insert into database
  const usageCount = 1; // Default usage count, or increment based on your logic
  db.run('INSERT INTO code_usage (code, video_page, usage_count) VALUES (?, ?, ?)', [code, videoPage, usageCount], (err) => {
    if (err) {
      console.error('Error logging code usage:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
    res.status(200).json({ message: 'Code usage logged successfully' });
  });
});
//
// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});