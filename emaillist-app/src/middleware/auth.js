function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) {
    return next();
  }
  // API requests get a JSON 401; page requests get redirected to login.
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Not logged in" });
  }
  return res.redirect("/login.html");
}

module.exports = { requireLogin };
