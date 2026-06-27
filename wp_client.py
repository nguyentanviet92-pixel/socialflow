import httpx
import base64
from typing import Optional, List, Dict

class WordPressClient:
    def __init__(self, wp_url: str, username: str = "", app_password: str = "", token: str = ""):
        """
        Accepts either:
          - token: pre-built "username:app_password" string (spaces in app_password are stripped)
          - username + app_password: individual fields (legacy)
        The token is base64-encoded and sent as HTTP Basic Auth header.
        """
        self.base = wp_url.rstrip("/") + "/wp-json/wp/v2"

        if token:
            # Token can be "user:pass" plain text or already base64-encoded
            try:
                # Try decoding to detect if already base64
                decoded = base64.b64decode(token).decode("utf-8")
                # Valid base64 with colon → use as-is
                if ":" in decoded:
                    creds = token.strip()
                else:
                    raise ValueError("not a user:pass base64")
            except Exception:
                # Plain "username:app_password" → strip spaces in password part
                if ":" in token:
                    parts = token.split(":", 1)
                    clean = parts[0] + ":" + parts[1].replace(" ", "")
                else:
                    clean = token.replace(" ", "")
                creds = base64.b64encode(clean.encode()).decode()
        else:
            clean_app_pass = app_password.replace(" ", "")
            creds = base64.b64encode(f"{username}:{clean_app_pass}".encode()).decode()

        self.headers = {
            "Authorization": f"Basic {creds}",
            "Content-Type": "application/json",
        }


    async def list_posts(
        self,
        per_page: int = 20,
        page: int = 1,
        status: str = "publish",
        categories: Optional[List[int]] = None,
        search: Optional[str] = None,
    ) -> List[dict]:
        params = {
            "per_page": per_page,
            "page": page,
            "status": status,
            "_fields": "id,title,slug,link,date,modified,categories,tags,excerpt,meta",
        }
        if categories:
            params["categories"] = ",".join(map(str, categories))
        if search:
            params["search"] = search

        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{self.base}/posts",
                headers=self.headers,
                params=params,
                timeout=15,
            )
            r.raise_for_status()
            return r.json()

    async def get_post(self, post_id: int) -> dict:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{self.base}/posts/{post_id}",
                headers=self.headers,
                params={"_fields": "id,title,slug,link,content,excerpt,categories,tags,meta,yoast_head_json"},
                timeout=15,
            )
            r.raise_for_status()
            return r.json()

    async def get_categories(self) -> List[dict]:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{self.base}/categories",
                headers=self.headers,
                params={"per_page": 100, "_fields": "id,name,slug,parent,count"},
                timeout=15,
            )
            r.raise_for_status()
            return r.json()

    async def update_post(self, post_id: int, data: dict) -> dict:
        """Phase 2: apply suggestions lên WP"""
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{self.base}/posts/{post_id}",
                headers=self.headers,
                json=data,
                timeout=30,
            )
            r.raise_for_status()
            return r.json()
