const CLOUD_URL = "http://127.0.0.1:3000";

// SET SESSIONS
exports.set_session = async () => {
  try {
    console.log("Setting Up Session");
    const res = await fetch(CLOUD_URL + "/notebook/proxy/set-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // important for session
      body: JSON.stringify({
        migid: "Mig-2",
        requestId: "6a639a430729040d619d58ba",
      }),
    });

    // READ THE COOKIE
    const setCookie = res.headers.get("set-cookie");

    if (setCookie) {
      // Keep only the actual cookie(s), remove attributes
      const cookieHeader = setCookie
        .split(/,(?=\s*\w+=)/) // handles multiple cookies
        .map((cookie) => cookie.split(";")[0])
        .join("; ");

      //   console.log("Cookie header:", cookieHeader);

      // Save globally
      global.sessionCookie = cookieHeader;
    }

    const data = await res.json();

    if (res.ok) {
      console.log("Session Setup OK");
      // TO DO
    } else {
      console.log(data.message || "Failed to initialize session");
    }
  } catch (err) {
    console.error(err);
  }
};

// GET VERSION OF THE APP
exports.get_version = async () => {
  try {
    const res = await fetch(CLOUD_URL + "/notebook/api/", {
      method: "GET",
      headers: {
        Cookie: global.sessionCookie,
      },
    });

    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      const data = await res.json();
      console.log("Application Version:", data.version);
    }
  } catch (err) {
    console.error("Request failed:", err);
  }
};

// GET ALL DIRECTORY CONTENT
exports.get_notebook_contents = async () => {
  try {
    const res = await fetch(CLOUD_URL + "/notebook/api/contents", {
      method: "GET",
      headers: {
        Cookie: global.sessionCookie,
      },
    });

    console.log("Status:", res.status);

    const content_type = res.headers.get("content-type");

    if (content_type?.includes("application/json")) {
      const data = await res.json();
      console.log("Contents:", data);
    }
  } catch (err) {
    console.error("Error fetching contents:", err);
  }
};
