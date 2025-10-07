import random
import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)

CORS(app)


@app.route("/test/getUserInfo")
def fetchserver():
    userID = request.args.get('userID')
    return {
        "userID":
        userID,
        "name":
        "mockingBrid",
        "tags": [{
            "color": "blue",
            "content": "tab A",
            "type": "normal",
        }, {
            "color": "green",
            "content": "tab b",
            "type": "normal",
        }],
        "password":
        None,
        "experience":
        100000,
        "avatar":
        "https://avatars1.githubusercontent.com/u/8186664?s=460&v=4",
        "authority": ["admin", "user", "super_admin"],
        "LastLoginTime":
        1716121099999,
        "RegisterTime":
        1716121000000,
        "personalSignature":
        "default signature"
    }


@app.route("/test/getSingleInfo")
def fetchserver1():
    return {
        "testVar":"mockingbird!"
    }


if __name__ == '__main__':
    app.run()
