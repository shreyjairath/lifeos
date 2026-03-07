import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        reload=True,
        reload_excludes=[".venv", "__pycache__"],
    )
