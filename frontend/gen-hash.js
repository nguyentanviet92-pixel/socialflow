const bcrypt = require('bcrypt');
bcrypt.hash('admin123', 12).then(h => {
  console.log(h);
  process.exit();
});
